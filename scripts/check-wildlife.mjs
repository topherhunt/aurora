// Node-side gates for the wildlife (src/v2/render/wildlife.js).
//
//   node scripts/check-wildlife.mjs
//
// The scatter runs against a synthetic moor: rolling ground, a pond in a basin,
// a crag too steep to stand on, and a long ramp rising into the snow at the far
// edge; the walk surface is the same field, since the plan reads the field and
// only the feet read the walk. Everything below is a way an animal can go wrong without
// anything throwing: a scatter that is not at each species' rate of one per 3000 square metres,
// or that is not the same twice; an animal standing in the water, up the crag
// or in the snow; a chapter of its score that does not sum to the
// chapter, start and end at home, or plan the same twice; a planned walk that
// leaves the tether or crosses ground it cannot stand on; one that skates
// (ground speed that is not the clip's stride); a graze that is not eat-down,
// chews, eat-up, or a sit that loops instead of playing its one round trip; a
// body that snaps to a new heading in a frame instead of turning to it; two
// clients stepping on different frame rates, or one joining mid-chapter, that
// do not agree on every animal's pose to the bit; an animal that takes any
// notice of her without a lure in her hand, or that does not follow one; a
// lure whose anchors do not put a peer's copy where the lurer's is, or a rejoin
// two clients derive differently; an animal in sight drawn as anything but its
// own animated puppet, one drawn past the last rung, or one that pops on, off or
// between rungs instead of dissolving; a debug tint that does not follow the
// rung, or that will not come off again; a herd that does not settle after
// dark; a frame that costs more than a scatter is allowed to.
// The three shipped GLBs are checked for shape too -- the halving ladder over
// the one skeleton, the whole clip library, the quadruped extras, and a bind
// pose that stands on y = 0 with its long axis on +X -- because the world loads
// them by name and builds every puppet from them.
//
// What this can NOT check: whether a stag reads as a stag, or whether the
// behaviour looks like grazing. That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import {
  Wildlife, SPECIES, CLIPS, ONE_SHOT, PLANTED, GRIP, LAIN, TILE, RADIUS, DENSITY, MAX, NIGHT_REST, PUPPETS, MAX_SLOPE, SNOW_MARGIN, TETHER_M, TURN_RATE, CARD_BODY_M, PROBE_EVERY, CARD_EVERY,
  LURE_M, LURE_FORGET_M, RESUME_M, FACE_M, SAMPLE_M, ANCHOR_S, ANCHOR_STALE_S, FLEE_M, STARTLE_S, FLEE_CLEAR_M, FLEE_S,
} from '../src/v2/render/wildlife.js'
import { CARD_RUNGS, CRITTER_GLB, CULL_KEEP, LOD_DEG, LOD_HYSTERESIS, LOD_RUNGS, LOD_STEP, critterTier, cullRange, forgetRange, lodReach, setTierTint } from '../src/v2/render/critters.js'
import { LOD_FADE_S, POSE_EVERY, REPLANT } from '../src/v2/render/puppet.js'
import { CATCH_UP_TICKS, CHAPTER_S, TICK_HZ, TICK_S, chapterOf, swing, tickAfter, tickOf } from '../src/sim/score.js'
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
}
// The field the plan is made on: the walk surface itself, here, under the one snow line.
const fieldOf = (of) => ({ snowLineAt: () => SNOW_LINE, heightAt: of.heightAt, normalAt: of.normalAt })
const height = fieldOf(walk)
const water = { isSubmerged: (x, z, y) => Math.hypot(x - POND.x, z - POND.z) < POND.r && y < POND.level }

// The same moor with nothing on it, for counting the scatter's rate against its own area.
const plain = {
  heightAt: () => GROUND,
  normalAt: (x, z, eps, out = { x: 0, y: 1, z: 0 }) => { out.x = 0; out.y = 1; out.z = 0; return out },
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
  const names = meshes.map((m) => m.name)
  check(meshes.length === LOD_RUNGS && names.join(',') === [id, ...Array.from({ length: LOD_RUNGS - 1 }, (_, k) => `${id}-lod${k + 1}`)].join(','), `${id}: one mesh per rung of the ladder, the rig then lod1 up, in the one file`, names.join(','))
  const prim = meshes[0]?.primitives[0]
  const tris = meshes.map((m) => (m.primitives[0] ? json.accessors[m.primitives[0].indices].count / 3 : 0))
  // Each rung halves: the shipper's TIER_FRACTIONS, rounded.
  check(tris.every((t, k) => k === 0 || Math.abs(t - tris[k - 1] / 2) <= 1), `${id}: each rung is half the triangles of the one above`, tris.join('/'))
  check(meshes.every((m) => m.primitives.length === 1 && m.primitives[0].attributes.JOINTS_0 !== undefined && m.primitives[0].attributes.WEIGHTS_0 !== undefined && m.primitives[0].attributes.NORMAL !== undefined && m.primitives[0].attributes.TEXCOORD_0 !== undefined && m.primitives[0].material === 0), `${id}: every rung is skinned, one primitive, on the one material`)
  const skinned = (json.nodes ?? []).filter((n) => n.skin !== undefined)
  check(json.skins?.length === 1 && skinned.length === LOD_RUNGS && skinned.every((n) => n.skin === 0), `${id}: ONE skeleton, worn by every rung -- a tier costs its triangles and not its bones`, `${json.skins?.[0]?.joints.length} joints`)

  const clips = (json.animations ?? []).map((a) => a.name)
  check(CLIPS.every((n) => clips.includes(n)) && clips.length === CLIPS.length, `${id}: the whole clip library, ${CLIPS.length} clips`, clips.join(' '))
  const joints = new Set(json.skins?.[0]?.joints ?? [])
  check((json.animations ?? []).every((a) => a.channels.every((ch) => joints.has(ch.target.node))), `${id}: every clip channel targets a joint of the skeleton`)
  const durs = Object.fromEntries((json.animations ?? []).map((a) => [a.name, Math.max(...a.samplers.map((s) => json.accessors[s.input].max[0]))]))
  check((json.animations ?? []).every((a) => a.samplers.every((s) => json.accessors[s.input].min !== undefined)) && Object.values(durs).every((d) => d > 0.2), `${id}: every sampler carries min and max, and no clip is shorter than 0.2 s`, Object.entries(durs).map(([n, d]) => `${n} ${d.toFixed(2)}`).join(' '))

  const quad = json.scenes?.[json.scene ?? 0]?.extras?.quadruped
  check(quad !== undefined && quad.span > 0 && quad.height > 0 && quad.width > 0 && quad.sizeM === roster.sizeM && quad.frame && Number.isFinite(quad.frame.yaw), `${id}: the scene carries the quadruped extras, at the roster's ${roster.sizeM} m`, quad && `span ${quad.span.toFixed(3)} width ${quad.width.toFixed(3)} height ${quad.height.toFixed(3)} yaw ${quad.frame.yaw.toFixed(3)}`)
  check(quad && ['walk', 'trot', 'run', 'hop', 'bound'].every((n) => quad.gait[n] > 0) && quad.gait.walk < quad.gait.trot && quad.gait.trot < quad.gait.run && quad.gait.hop < quad.gait.bound && quad.gait.idle === undefined, `${id}: the gaits carry a ground speed each, walk under trot under run and hop under bound, and nothing else does`, quad && Object.entries(quad.gait).map(([n, v]) => `${n} ${v.toFixed(3)}`).join(' '))
  const jointNames = new Set([...joints].map((j) => json.nodes[j].name))
  check(quad?.legs?.length === 4 && quad.legs.every((l) => l.chain.length >= 3 && l.chain.every((n) => jointNames.has(n))), `${id}: four legs named, hip to foot, every joint of every chain one of the skeleton's -- the puppet's foot IK reads its feet off them`, quad?.legs && quad.legs.map((l) => `${l.id} ${l.chain.length}`).join(' '))

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

// --- stand-in assets: a slab on a skeleton of a spine and four legs, the shipped numbers ---------
// A leg is hip, knee, foot: the hip under a corner of the body, the knee bent forward, the foot a hair over the ground, so the puppet's foot IK has a bend to work.
const LEG_HIP_Y = 0.6
const LEG_FOOT_Y = 0.02
function makeAsset(key) {
  const { json } = shipped[key]
  const quad = json.scenes[json.scene ?? 0].extras.quadruped
  const root = new THREE.Bone()
  root.name = 'tripo::Root'
  const spine = new THREE.Bone()
  spine.name = 'Spine'
  spine.position.set(0.2, 0.1, 0)
  root.add(spine)
  const bones = [root, spine]
  const legs = []
  for (const [id, sx, sz] of [['FL', 1, 1], ['FR', 1, -1], ['HL', -1, 1], ['HR', -1, -1]]) {
    const hip = new THREE.Bone()
    hip.name = `Hip${id}`
    hip.position.set(sx * quad.span * 0.3, quad.height * LEG_HIP_Y, sz * quad.width * 0.3)
    const knee = new THREE.Bone()
    knee.name = `Knee${id}`
    knee.position.set(quad.height * 0.12, -quad.height * 0.3, 0)
    const foot = new THREE.Bone()
    foot.name = `Foot${id}`
    foot.position.set(-quad.height * 0.12, -quad.height * (LEG_HIP_Y - 0.3 - LEG_FOOT_Y), 0)
    root.add(hip)
    hip.add(knee)
    knee.add(foot)
    bones.push(hip, knee, foot)
    legs.push({ id, chain: [hip.name, knee.name, foot.name] })
  }
  root.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  // One slab a rung, coarser down the ladder, so a test can tell which tier is drawn.
  const tiers = Array.from({ length: LOD_RUNGS }, (_, k) => {
    const g = new THREE.BoxGeometry(quad.span, quad.height, quad.width, LOD_RUNGS - k, 1, 1).translate(0, quad.height / 2, 0)
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
  return { root, skeleton, tiers, clips, map: null, legs, gait: quad.gait, sizeM: quad.sizeM, span: quad.span, width: quad.width, height: quad.height }
}
const STAND_IN_BONES = 2 + 4 * 3
const assets = () => Object.fromEntries(SPECIES.map((sp) => [sp.key, makeAsset(sp.key)]))

// --- construction ---------------------------------------------------------------
const scene = new THREE.Scene()
// `eat` is hands.js eatLure: whether her carrot was hers to give.
const make = (seed, world = { walk, water, height }, dayness = null, eat = () => true) =>
  new Wildlife(scene, world.height ?? fieldOf(world.walk), world.water, { seed, walk: world.walk, dayness, eat, assets: assets() })
// For a gate about something else: her head on top of a wary animal without it bolting.
const calm = (of) => { of._startled = () => false; return of }
const w = make(7)
check(w.loaded && w.species.length === 3 && w.species.map((s) => s.key).join(',') === 'stag,fox,hare', 'the three of them are loaded')
check(w.species.every((sp) => sp.puppets.length === PUPPETS && sp.freePuppets.length === PUPPETS && sp.slots.length === MAX && sp.free.length === MAX), `${PUPPETS} puppets and ${MAX} slots a species, all free`)
check(w.materials.length === 3 * (PUPPETS * 2 + 2), 'ONE settled material a species and a dissolving pair a puppet, plus the one card material a species, all offered to the lighting')
check(w.species.every((sp) => sp.materials.every((m) => m.plain.customProgramCacheKey() === `wildlife-${sp.key}` && m.in.customProgramCacheKey() === `wildlife-${sp.key}-fade` && m.out.customProgramCacheKey() === `wildlife-${sp.key}-fade`)) && new Set(w.materials.map((m) => m.customProgramCacheKey())).size === 9, 'three programs a species and not one a puppet: a settled one with no discard in it at all, the dissolve both halves of a fade share, and the card')
check(w.species.every((sp) => sp.cardMaterial.customProgramCacheKey() === `wildlife-${sp.key}-card-spun-fade-flat`), 'and the card is its own program: spun to face her, dithered like everything else that arrives or leaves, and flat, wearing no hue its mesh could not wear back')
check(w.batch.children.length === 3 && w.species.every((sp) => w.batch.children.includes(sp.cardMesh) && sp.cardMesh.count === 0 && !sp.cardMesh.visible), 'the batch holds one card mesh a species -- empty, and not drawn at all until the cards are photographed -- and otherwise only the puppets it lends out')
check(w.species.every((sp) => sp.puppets.every((p) => p.skeleton !== sp.asset.skeleton && p.skeleton.bones.length === STAND_IN_BONES && p.meshes.length === LOD_RUNGS && p.meshes.every((m) => m.skeleton === p.skeleton && !m.visible) && !p.group.matrixAutoUpdate && p.actions.size === CLIPS.length)), 'each puppet has its own copy of the skeleton, every shared tier bound to it, none shown, and an action per clip')
check(w.species.every((sp) => sp.puppets.every((p) => [...p.actions].every(([name, a]) => (ONE_SHOT.has(name) ? a.loop === THREE.LoopOnce && a.clampWhenFinished : a.loop === THREE.LoopRepeat)))), `${[...ONE_SHOT].join(', ')} play once and hold, the rest cycle`)
{
  const compile = (m) => {
    const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <clipping_planes_fragment>\n#include <map_fragment>\n' }
    m.onBeforeCompile(shader)
    return shader
  }
  const sp0 = w.species[0]
  const mats = sp0.materials[0]
  const plain = compile(mats.plain)
  check(sp0.materials.every((m) => m.plain === sp0.plain) && sp0.materials.length === PUPPETS, 'every puppet of a species draws its settled tiers through THE ONE material, so a drawn herd is one material change a frame and not one an animal')
  const card = compile(sp0.cardMaterial)
  check(!plain.fragmentShader.includes('uHue') && !plain.vertexShader.includes('aHue') && !card.vertexShader.includes('aHue') && !card.fragmentShader.includes('vHue'), 'and nothing in it is per-animal: no puppet and no card wears a hue, a skinned body having nowhere but a uniform to keep one and a uniform costing a material an animal')
  check(!plain.fragmentShader.includes('discard'), 'a settled puppet draws through a shader with no discard in it, so it does not cost a tiled GPU its early-Z')
  const [a, b] = [compile(mats.in), compile(mats.out)]
  check(a.uniforms.uCut === mats.uCut && b.uniforms.uCut === mats.uCut && a.uniforms.uSide.value === -b.uniforms.uSide.value, 'both halves of a fade read the one cut and compare it the opposite way round')
  check(a.fragmentShader === b.fragmentShader && a.fragmentShader.includes('gl_FragCoord') && !a.fragmentShader.includes('uTime'), 'off the same screen-space hash, with no time in it -- so the masks are complementary and the pattern does not crawl')
  check(a.fragmentShader.indexOf('discard') < a.fragmentShader.indexOf('#include <map_fragment>'), 'and the test comes before the texture fetch, so a dropped fragment costs nothing but itself')
}

// --- the scatter's rate ----------------------------------------------------------
// A spawn is a placement the tiles hold; a slot is one woken into a live animal.
const scatter = (of) => [...of.tiles.values()].flatMap((t) => t.spawns)
const alive = (of) => of.species.flatMap((sp) => sp.slots.filter((c) => c.spawn !== null))
// Each instance is fed the room clock by hand: an update carries the world second, never a dt.
const clocks = new WeakMap()
const timeOf = (of) => clocks.get(of) ?? 0
const step = (of, hx, hy, hz, dt = 0, lures) => {
  const t = timeOf(of) + dt
  clocks.set(of, t)
  of.update(hx, hy, hz, t, lures)
  return t
}
const jump = (of, t) => clocks.set(of, t)
// Waking is the update's job, not place()'s, so a gate that wants animals runs a frame.
const wake = (of, hx = 0, hz = 0) => { step(of, hx, GROUND + 1.6, hz, 0); return of }
// A hare's cull is under thirty metres, so the only way to see one alive is to go and stand over it.
const beside = (of, key) => {
  const s = scatter(of).find((c) => c.sp.key === key)
  // Her head past FLEE_M over it, so a wary one wakes on its score and not running from her.
  step(of, s.x, s.y + FLEE_M + 1, s.z, 0)
  return of.species.find((sp) => sp.key === key).slots.find((c) => c.spawn === s)
}
// Put an animal into a phrase of the gate's choosing at the instance's clock: the score is the
// only thing that normally enters a phrase, so a gate that wants a known walk or a known stand
// hands one in and is on its own past the phrase's end.
const pose = (c) => ({ x: c.sx, z: c.sz, heading: c.sh })
const force = (of, c, ph, t = timeOf(of)) => {
  c.live = c.rejoin = c.lure = null
  c.detour = 0
  of._place(c, ph.from)
  of._enter(c, { phrase: ph, start: t, end: t + ph.dur, index: 0, chapter: c.chapter, rejoin: false })
  c.rec.tick = tickAfter(t) - 1
  c.rec.alpha = 1
  of._pose(c)
  return c
}
const still = (of, c, kind, clip, heading = c.sh) => force(of, c, of._still(kind, pose(c), [[clip, 1e6]], heading))
const walkOn = (of, c, aim, gait = c.sp.gaits[0][0], ticks = 2000) => force(of, c, of._walkPhrase('roam', pose(c), aim, gait, c.sp.asset.gait[gait] * c.k, ticks))
const SEEDS = 40
{
  const counts = Object.fromEntries(SPECIES.map((sp) => [sp.key, 0]))
  let tiles = 0
  let overflow = 0
  for (let seed = 1; seed <= SEEDS; seed++) {
    const k = make(seed, { walk: plain, water: noWater })
    k.place(0, 0)
    wake(k)
    tiles += k.tiles.size
    overflow += k.overflow
    for (const c of scatter(k)) counts[c.sp.key]++
    k.dispose()
  }
  const area = tiles * TILE * TILE
  const rates = Object.fromEntries(Object.entries(counts).map(([key, n]) => [key, n / area]))
  check(overflow === 0, 'every spawn inside its cull range found a slot to wake into, over every seed', `${overflow} over ${SEEDS} seeds`)
  check(SPECIES.every((sp) => Math.abs(rates[sp.key] / (DENSITY * sp.rate) - 1) < 0.12), `each species at its rate of one per ${Math.round(1 / DENSITY)} square metres on open ground: ${SPECIES.map((sp) => `${sp.key} x${sp.rate}`).join(', ')}`, Object.entries(rates).map(([k2, r]) => `${k2} 1 per ${Math.round(1 / r)}`).join(', ') + ` over ${Math.round(area / 1e3)}k m2`)
  check(Object.values(counts).every((n) => n > 100), 'and enough of each to say so', JSON.stringify(counts))
}

// --- where they sit --------------------------------------------------------------
w.place(0, 0)
wake(w)
{
  const pool = []
  for (let seed = 1; seed <= SEEDS; seed++) {
    const k = make(seed)
    k.place(0, 0)
    for (const c of scatter(k)) pool.push({ key: c.sp.key, x: c.x, y: c.y, z: c.z, size: c.size, nx: c.nx, ny: c.ny, nz: c.nz })
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
  check(pool.every((c) => Math.abs(c.y - fieldAt(c.x, c.z)) < 1e-9), 'every animal is on the walk surface, not floating over it')
  check(pool.every((c) => Math.hypot(c.nx, c.ny, c.nz) - 1 < 1e-9), 'each carries the unit normal of the ground it stands on')
  const aside = make(3)
  aside.place(0, 0)
  for (const sp of SPECIES) {
    const mine = pool.filter((c) => c.key === sp.key)
    const quad = shipped[sp.key].json.scenes[0].extras.quadruped
    const drawM = quad.sizeM * sp.scale
    const sizes = mine.map((c) => c.size)
    // The spread has to be seen as well as allowed: a vary that stopped being rolled would still pass a bound.
    const spread = (Math.max(...sizes) - Math.min(...sizes)) / drawM
    check(sizes.every((s) => Math.abs(s / drawM - 1) <= sp.vary + 1e-9) && spread > sp.vary, `a ${sp.key} is ${drawM} m (${quad.sizeM} shipped${sp.scale === 1 ? '' : ` x ${sp.scale}`}) give or take ${Math.round(sp.vary * 100)}%, and the range is walked`, `${Math.min(...sizes).toFixed(2)} to ${Math.max(...sizes).toFixed(2)} m`)
    const one = beside(aside, sp.key)
    check(one && Math.abs(one.k - one.size / quad.span) < 1e-9, `and wears the scale that makes it so`, `${one.size.toFixed(2)} m at ${one.k.toFixed(3)}`)
  }
  aside.dispose()
  // Determinism: the same seed lays the same animals twice.
  const key = (of) => scatter(of).map((c) => `${c.sp.key}:${c.x.toFixed(4)},${c.y.toFixed(4)},${c.z.toFixed(4)},${c.size.toFixed(4)}`).sort().join('|')
  const again = make(7)
  again.place(0, 0)
  check(key(again) === key(w) && scatter(w).length > 0, 'the scatter is a pure function of the seed', `${scatter(w).length} animals`)
  // And of position: the tiles she keeps hold the same animals when she steps.
  const kept = scatter(again).filter((c) => Math.hypot(c.x, c.z) < 30).map((c) => ({ c, x: c.x, z: c.z }))
  step(again, TILE, GROUND + 1.6, 0)
  const held = new Set(scatter(again))
  check(kept.length > 0 && kept.every(({ c, x, z }) => held.has(c) && c.x === x && c.z === z), 'a step of one tile leaves the animals she keeps exactly where they were', `${kept.length} kept`)
  again.dispose()
}

// --- the score --------------------------------------------------------------------
// A chapter is what every client derives for an animal from its key and the clock, so every
// phrase's shape is checked here in the closed form the plan wrote, not by stepping it.
const turnTicks = (sw) => Math.max(0, Math.ceil(Math.abs(sw) / (TURN_RATE * TICK_S) - 1e-9) - 1)
const onTicks = (s) => Math.abs(s * TICK_HZ - Math.round(s * TICK_HZ)) < 1e-6
{
  const now = timeOf(w)
  const herd = alive(w)
  const acts = Object.fromEntries(SPECIES.map((sp) => [sp.key, new Set()]))
  const gaits = Object.fromEntries(SPECIES.map((sp) => [sp.key, new Set()]))
  let sums = 0, chained = 0, ends = 0, grid = 0, walks = 0, walkShape = 0, walkGround = 0, grazes = 0, grazeShape = 0, rests = 0, restShape = 0, clips = 0, phrases = 0, chapters = 0
  const chews = new Set()
  for (const c of herd) {
    // Thirty chapters an animal: enough to see every act of every species rolled.
    for (let n = 0; n < 30; n++) {
      const ch = w.score.chapter(c.key, now + n * CHAPTER_S)
      chapters++
      const ps = ch.phrases
      if (Math.abs(ps.reduce((s, p) => s + p.dur, 0) - CHAPTER_S) < 1e-6) sums++
      if (ps.every((p, i) => i === 0 || p.from === ps[i - 1].to)) chained++
      const last = ps[ps.length - 1]
      if (ps[0].from === c.home && last.kind === 'stand' && last.to.x === c.home.x && last.to.z === c.home.z && last.to.heading === c.home.heading) ends++
      if (ps.every((p) => onTicks(p.dur) && p.steps.every((st) => onTicks(st[1])))) grid++
      for (const p of ps) {
        phrases++
        acts[c.sp.key].add(p.kind)
        if (p.steps.every((st) => CLIPS.includes(st[0]))) clips++
        if (p.mps !== undefined) {
          walks++
          gaits[c.sp.key].add(p.gait)
          const dist = Math.hypot(p.to.x - p.from.x, p.to.z - p.from.z)
          const ticks = Math.round(p.dur * TICK_HZ) - p.turn
          const straight = ticks * p.mps * TICK_S
          // The end is where the ticks put it, or, for the walk home, the home it was sent to, which the ticks reach and the snap finishes.
          const shaped = p.turn === turnTicks(swing(p.from.heading, p.aim)) && Math.abs(p.to.heading - p.aim) < 1e-9 && p.mps === c.sp.asset.gait[p.gait] * c.k && (Math.abs(dist - straight) < 1e-6 || (dist < straight + 1e-6 && dist > straight - p.mps * TICK_S - 1e-6)) && p.steps.length === 1 && p.steps[0][0] === p.gait && p.steps[0][1] === p.dur
          if (shaped && c.sp.gaits.some(([g]) => g === p.gait)) walkShape++
          // The plan's own sample points, in the plan's own arithmetic: a roam is sampled along its aim, the walk home along the chord to home.
          const home = p.to.x === c.home.x && p.to.z === c.home.z
          let ground = true
          for (let s = SAMPLE_M; s <= dist + 1e-9 && ground; s += SAMPLE_M) {
            const at = Math.min(s, dist)
            const u = at / dist
            ground = home
              ? w._walkable(p.from.x + (p.to.x - p.from.x) * u, p.from.z + (p.to.z - p.from.z) * u, c.home)
              : w._walkable(p.from.x + Math.cos(p.aim) * at, p.from.z - Math.sin(p.aim) * at, c.home)
          }
          if (ground) walkGround++
        }
        if (p.kind === 'graze') {
          grazes++
          const d = c.sp.durations
          const n = p.steps[1]?.[1] / d['eat-loop']
          if (p.steps.length === 3 && p.steps[0][0] === 'eat-down' && p.steps[1][0] === 'eat-loop' && p.steps[2][0] === 'eat-up' && Math.abs(p.steps[0][1] - d['eat-down']) < TICK_S && Math.abs(p.steps[2][1] - d['eat-up']) < TICK_S && Math.abs(n - Math.round(n)) < 0.02 && n >= 2) { grazeShape++; chews.add(Math.round(n)) }
        }
        if (p.kind === 'rest') {
          rests++
          if (p.steps.length === 1 && (p.steps[0][0] === 'sit' || p.steps[0][0] === 'lie') && Math.abs(p.steps[0][1] - c.sp.durations[p.steps[0][0]]) < TICK_S) restShape++
        }
      }
    }
  }
  const keys = scatter(w).map((s) => s.key)
  check(new Set(keys).size === keys.length && keys.every((k) => /^(st|fx|hr):-?\d+,-?\d+:\d+$/.test(k)), 'every spawn has its own key, the tile and its index in the roll -- not the tile seed, which mirror tiles share', `${keys.length} keys, e.g. ${keys[0]}`)
  check(herd.length > 3 && sums === chapters, `every chapter's phrases sum to the ${CHAPTER_S} s chapter`, `${sums} of ${chapters} chapters, ${herd.length} animals`)
  check(chained === chapters, 'each phrase starts from the pose the last one ended at, the same object')
  check(ends === chapters, 'a chapter starts from home and ends standing at home, turned to its home heading, so the chapter turn is from nothing')
  check(grid === chapters, 'every phrase and every step of it is a whole number of ticks long, so its boundary is one tick on every client')
  check(clips === phrases, 'every step plays a clip of the library')
  check(walks > 0 && walkShape === walks, 'a walk pivots to its aim at TURN_RATE and goes straight at its gait\'s stride, ending exactly where its ticks put it', `${walkShape} of ${walks}`)
  check(walkGround === walks, `every metre of every walk is on ground the animal could stand on, inside the ${TETHER_M} m tether`, `${walkGround} of ${walks}`)
  check(grazes > 0 && grazeShape === grazes && chews.size > 2, 'a graze is eat-down, whole chews (two or more), eat-up', `${grazes} grazes, chews of ${[...chews].sort((a, b) => a - b).join('/')}`)
  check(rests > 0 && restShape === rests, 'a rest is one sit or one lie, timed by its own length', `${rests} rests`)
  check(SPECIES.every((sp) => sp.acts.every(([a]) => acts[sp.key].has(a) || (a === 'roam' && acts[sp.key].has('stand')))), 'every act of every species is rolled', SPECIES.map((sp) => `${sp.key} ${[...acts[sp.key]].join('/')}`).join(', '))
  check(SPECIES.every((sp) => sp.gaits.every(([g]) => gaits[sp.key].has(g)) && [...gaits[sp.key]].every((g) => sp.gaits.some(([h]) => h === g))), 'and every gait of each, and no other: a hare hops and bounds and never walks', SPECIES.map((sp) => `${sp.key} ${[...gaits[sp.key]].join('/')}`).join(', '))
  // Determinism: a second instance plans the same chapter, and planning a later chapter first changes nothing about an earlier one.
  const shape = (ch) => ch.phrases.map((p) => `${p.kind}/${p.dur}/${p.to.x}/${p.to.z}/${p.to.heading}/${p.steps.map((s) => s.join(':')).join(',')}`).join('|')
  const twin = make(7)
  twin.place(0, 0)
  wake(twin)
  const c = herd[0]
  const one = shape(w.score.chapter(c.key, now))
  check(shape(twin.score.chapter(c.key, now + 3 * CHAPTER_S)) === shape(w.score.chapter(c.key, now + 3 * CHAPTER_S)) && shape(twin.score.chapter(c.key, now)) === one, 'a chapter is a pure function of the key and the chapter: a second instance plans it alike, whichever chapter it planned first', `${one.slice(0, 60)}...`)
  twin.dispose()
}

// --- the walk --------------------------------------------------------------------
{
  const k = make(7)
  k.place(0, 0)
  wake(k)
  const c = alive(k).filter((a) => Math.hypot(a.x, a.z) > 60)[0]
  // Facing where it is going, so this is the ground speed alone and not a pivot; four seconds of it, so the score has it back before the wander below.
  walkOn(k, c, c.sh, c.sp.gaits[0][0], 80)
  const dt = 1 / 60
  const from = c.phrase.from
  const FRAMES = 30
  // Her head just past FLEE_M, so it is on a mesh rung and stepped every frame.
  for (let f = 0; f < FRAMES; f++) step(k, c.x + FLEE_M + 1, GROUND + 1.6, c.z, dt)
  const moved = Math.hypot(c.x - from.x, c.z - from.z)
  const owed = c.speed * (timeOf(k) - c.phraseTick0 * TICK_S)
  check(c.lod < LOD_RUNGS && Math.abs(moved - owed) < 1e-6, 'a moving animal covers exactly the ground its clip was built for, closed-form from the phrase\'s first tick -- it does not skate', `${moved.toFixed(4)} m in ${(FRAMES * dt).toFixed(2)} s at ${c.speed.toFixed(3)} m/s, rung ${c.lod}`)
  check(Math.abs((c.x - from.x) / moved - Math.cos(c.heading)) < 1e-6 && Math.abs((c.z - from.z) / moved + Math.sin(c.heading)) < 1e-6, 'and it goes the way it is facing')
  // On the card rung, once its puppet has dissolved out, it is stepped every CARD_EVERY frames, and where it is drawn is still the closed form at the frame it was last stepped.
  for (let f = 0; f < 100 && (c.lod !== LOD_RUNGS || c.puppet); f++) step(k, 0, GROUND + 1.6, 0, dt)
  const steps = new Set([c.x])
  let at = timeOf(k)
  for (let f = 0; f < 2 * CARD_EVERY * CARD_EVERY; f++) {
    const t = step(k, 0, GROUND + 1.6, 0, dt)
    if (!steps.has(c.x)) at = t
    steps.add(c.x)
  }
  const movedFar = Math.hypot(c.x - from.x, c.z - from.z)
  const owedFar = c.speed * (at - c.phraseTick0 * TICK_S)
  check(c.lod === LOD_RUNGS && steps.size === 2 * CARD_EVERY + 1 && Math.abs(movedFar - owedFar) < 1e-6, `on the card rung it moves on one frame in ${CARD_EVERY}, and is exactly where the score has it on each`, `${steps.size - 1} moves in ${2 * CARD_EVERY * CARD_EVERY} frames, ${movedFar.toFixed(4)} m of ${owedFar.toFixed(4)}, rung ${c.lod}`)
  k.dispose()
}

// Ten minutes of wandering, her head far off.
// The body is where the score says between samples a metre apart, so it may stand
// half a stride into what a sample would have refused: the softest edge of any of it.
const seatNear = (of, x, z, r = SAMPLE_M / 2 + 0.01) => {
  if (of.seat(x, z) !== null) return true
  for (let i = 0; i < 8; i++) if (of.seat(x + Math.cos((i * Math.PI) / 4) * r, z + Math.sin((i * Math.PI) / 4) * r) !== null) return true
  return false
}
{
  const dt = 1 / 60
  const far = new Map() // the spawn -> where its animal stood when the minute began
  const got = new Map() // -> and where it has got to since
  let strayed = 0
  let ms = 0
  for (const a of alive(w)) if (Math.hypot(a.home.x, a.home.z) > 60) far.set(a.spawn, [a.x, a.z])
  // Every heading of every animal, every frame: a pivot to a roam's aim, the
  // turn home and the chapter's turn to its home heading all pass through here,
  // and not one of them may move a body faster than it can turn -- a card
  // animal over the CARD_EVERY frames it is stepped across, the rest over one. A
  // slot that went to sleep and was woken again holds a different animal, which
  // is a placement and not a turn.
  let snapped = 0
  let watched = 0
  let was = new Map()
  // Between probes an animal rides the tangent plane it last read rather than
  // asking the ground again, so its feet float by the field's curvature over one
  // probe stride -- and the coarser strides are the ones far enough off that the
  // float is nothing to look at. So the promise is in ARC, the currency the whole
  // ladder is in: a float is never a fraction of a degree of her view. And a
  // probe seats it exactly again, so nothing accumulates.
  let floated = 0
  let arc = 0
  let seated = 0
  let lived = 0
  let off = 0
  let offAt = ''
  for (let f = 0; f < 3600; f++) {
    const t0 = performance.now()
    step(w, 0, GROUND + 1.6, 0, dt)
    ms += performance.now() - t0
    const seen = new Map()
    for (const a of alive(w)) {
      const prev = was.get(a)
      if (prev && prev.spawn === a.spawn) { snapped = Math.max(snapped, Math.abs(swing(prev.heading, a.heading)) / (a.lod === LOD_RUNGS || prev.lod === LOD_RUNGS ? CARD_EVERY : 1)); watched++ }
      seen.set(a, { spawn: a.spawn, heading: a.heading, lod: a.lod })
      const drift = Math.abs(a.y - fieldAt(a.x, a.z))
      floated = Math.max(floated, drift)
      arc = Math.max(arc, drift / Math.hypot(a.x, a.y - GROUND - 1.6, a.z))
      lived++
      if (drift < 1e-9) seated++
      if (!seatNear(w, a.x, a.z)) { off++; offAt = `${a.sp.key} at ${a.x.toFixed(2)},${a.z.toFixed(2)}` }
      if (far.has(a.spawn)) { strayed = Math.max(strayed, Math.hypot(a.x - a.home.x, a.z - a.home.z)); got.set(a.spawn, [a.x, a.z]) }
    }
    was = seen
  }
  check(snapped <= TURN_RATE * dt + 1e-9, `in ${(watched / 1000).toFixed(0)}k animal-frames of wandering, no body ever turned faster than it may`, `worst ${(snapped / dt).toFixed(3)} rad/s of ${TURN_RATE}, a card animal's swing over the ${CARD_EVERY} frames between its steps`)
  const wandered = [...far].filter(([sp, [x, z]]) => got.has(sp) && Math.hypot(got.get(sp)[0] - x, got.get(sp)[1] - z) > 1)
  check(far.size > 0 && wandered.length > far.size / 2, 'most of them have wandered somewhere in a minute', `${wandered.length} of ${far.size}`)
  check(strayed <= TETHER_M + 0.01, `and none has left its ${TETHER_M} m tether`, `furthest ${strayed.toFixed(2)} m`)
  check(off === 0, `nobody has walked into the water or up the crag, to within half the ${SAMPLE_M} m the plan samples a walk at`, off ? `${off} animal-frames off, last ${offAt}` : '')
  check(arc * (180 / Math.PI) < 0.25, 'and no animal has floated off the ground by a quarter of a degree of her view, which is what a probe stride of tangent-plane walking is worth', `worst ${(arc * (180 / Math.PI)).toFixed(3)} deg, ${floated.toFixed(3)} m`)
  check(seated > lived / 20, 'because every probe seats its animal back onto the ground exactly, so the float never accumulates', `${((seated / lived) * 100).toFixed(1)}% of ${(lived / 1000).toFixed(0)}k animal-frames dead on it`)
  check(w.starved === 0, `and in a minute of it no animal in sight ever went undrawn for want of one of the ${PUPPETS} puppets`, `${w.starved} starved`)
  const perFrame = ms / 3600
  check(perFrame < 1.5, `a frame of ${alive(w).length} animals costs under 1.5 ms`, `${perFrame.toFixed(3)} ms`)
}

// --- every client agrees ------------------------------------------------------------
// What a frame draws is a pure function of the key and the clock: two instances on
// different frame rates, and one that joins mid-way, hold every animal alike to the bit.
// Four still frames at the end put every card animal on its stepped frame, so the
// drawn pose is compared and not the cadence it was drawn on. An animal past its
// card range is not drawn and not stepped (its slot waits to see whether she
// comes back), so it is nothing to compare.
const settle = (of, t) => { jump(of, t); for (let i = 0; i < CARD_EVERY; i++) step(of, 0, GROUND + 1.6, 0, 0) }
const snapshot = (of) => new Map(alive(of).filter((c) => c.lod !== CARD_RUNGS).map((c) => [c.key, [c.x, c.z, c.heading, c.sx, c.sz, c.sh, c.rec.tick, c.phraseIndex, c.chapter, c.act, c.clip, c.stepStart, c.rejoin ? 'rejoin' : 'plan', c.live ? 'live' : ''].join('/')]))
const differ = (p, q) => {
  if (p.size !== q.size) return `${p.size} vs ${q.size} animals`
  for (const [k, v] of p) if (q.get(k) !== v) return `${k}: ${v} vs ${q.get(k)}`
  return null
}
{
  const T1 = 37.3
  const T = 61
  const a = make(7)
  a.place(0, 0)
  const b = make(7)
  b.place(0, 0)
  // Woken together at the clock's zero and stepped apart: a at sixty a second, b on a ragged frame.
  wake(a)
  wake(b)
  const dts = [1 / 30, 1 / 90, 1 / 45]
  for (let f = 0; timeOf(a) + 1 / 60 <= T1; f++) step(a, 0, GROUND + 1.6, 0, 1 / 60)
  for (let f = 0; timeOf(b) + dts[f % 3] <= T1; f++) step(b, 0, GROUND + 1.6, 0, dts[f % 3])
  settle(a, T1)
  settle(b, T1)
  const atT1 = snapshot(a)
  let d = differ(atT1, snapshot(b))
  check(d === null && atT1.size > 3 && [...atT1.values()].some((v) => v.split('/')[9] === 'roam'), 'two clients on different frame rates draw every animal at the same place, facing the same way, in the same step of the same phrase', d ?? `${atT1.size} animals alike at ${T1} s`)
  // A joiner arrives at T1 with nothing to replay: it is placed closed-form where the others already have it.
  const c = make(7)
  c.place(0, 0)
  jump(c, T1)
  step(c, 0, GROUND + 1.6, 0, 0)
  check(c.stats.behind === 0 && c.stats.replayed === 0, 'a client joining mid-chapter places every animal in one frame, replaying nothing', `${c.stats.replayed} ticks replayed, ${c.stats.behind} behind`)
  settle(c, T1)
  d = differ(atT1, snapshot(c))
  check(d === null, 'and has every one of them exactly where the clients that stepped the whole way do', d ?? '')
  // And on from there together.
  for (let f = 0; timeOf(a) + 1 / 60 <= T; f++) step(a, 0, GROUND + 1.6, 0, 1 / 60)
  for (let f = 0; timeOf(b) + dts[f % 3] <= T; f++) step(b, 0, GROUND + 1.6, 0, dts[f % 3])
  for (let f = 0; timeOf(c) + 1 / 60 <= T; f++) step(c, 0, GROUND + 1.6, 0, 1 / 60)
  settle(a, T)
  settle(b, T)
  settle(c, T)
  const atT = snapshot(a)
  d = differ(atT, snapshot(b)) ?? differ(atT, snapshot(c))
  check(d === null, `and ${(T - T1).toFixed(1)} s on all three still agree`, d ?? '')
  // A tab that slept: ten seconds is replayed tick by tick, thirty is past the replay budget and placed afresh, and either way it is where a fresh client has it.
  const fresh = (t) => { const k = make(7); k.place(0, 0); settle(k, t); const s = snapshot(k); k.dispose(); return s }
  jump(a, T + 10)
  step(a, 0, GROUND + 1.6, 0, 0)
  const replayedA = a.stats.replayed
  settle(a, T + 10)
  check(replayedA >= 10 * TICK_HZ && a.stats.behind === 0 && differ(fresh(T + 10), snapshot(a)) === null, 'a client that froze for ten seconds replays them and agrees with a fresh one', `${replayedA} ticks replayed on the first frame`)
  jump(b, T + 30)
  step(b, 0, GROUND + 1.6, 0, 0)
  const replayedB = b.stats.replayed
  settle(b, T + 30)
  check(replayedB === 0 && b.stats.behind === 0 && differ(fresh(T + 30), snapshot(b)) === null, `one that froze for thirty (past the ${CATCH_UP_TICKS / TICK_HZ} s replay budget) is placed afresh, and agrees too`, `${replayedB} ticks replayed`)
  a.dispose(); b.dispose(); c.dispose()
}

// --- night puts them down ---------------------------------------------------------
{
  // The plan's own rolls, over many chapters of every animal she wakes from a grid
  // of nine stands (a hare's card range is short), under a noon sky, a dark one and
  // dusk. The last stand and the walk home before it are not rolled, so they are left out.
  const share = (dayness) => {
    const k = make(11, { walk: plain, water: noWater }, dayness)
    k.place(0, 0)
    const out = {}
    const rolls = Object.fromEntries(k.species.map((sp) => [sp.key, { rests: 0, rolled: 0 }]))
    const seen = new Set()
    for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
      step(k, gx * 60, GROUND + 1.6, gz * 60, 0)
      for (const c of alive(k)) {
        if (seen.has(c.key)) continue
        seen.add(c.key)
        const r = rolls[c.sp.key]
        for (let n = 0; n < 30; n++) {
          const ps = k.score.chapter(c.key, n * CHAPTER_S + chapterOf(0, c.key).offset + 1).phrases.slice(0, -1)
          const back = ps[ps.length - 1]
          if (back && back.mps !== undefined && back.to.x === c.home.x && back.to.z === c.home.z) ps.pop()
          for (const p of ps) { r.rolled++; if (p.kind === 'rest') r.rests++ }
        }
      }
    }
    for (const sp of k.species) {
      out[sp.key] = rolls[sp.key].rests / rolls[sp.key].rolled
      out[`${sp.key}N`] = rolls[sp.key].rolled
    }
    k.dispose()
    return out
  }
  const day = share(() => 1)
  const night = share(() => 0)
  // A rest's weight doubles while the others keep theirs, so its share rises by less than NIGHT_REST: w*2/(w*2 + rest-of-the-weights).
  const want = Object.fromEntries(SPECIES.map((sp) => {
    const total = sp.acts.reduce((t, [, x]) => t + x, 0)
    const r = sp.acts.find(([n]) => n === 'rest')[1]
    return [sp.key, (r * NIGHT_REST) / (total + r * (NIGHT_REST - 1))]
  }))
  check(SPECIES.every((sp) => day[`${sp.key}N`] > 10000 && Math.abs(night[sp.key] / want[sp.key] - 1) < 0.08), `at full dark a rest is ${NIGHT_REST}x the weight it carries at noon`, SPECIES.map((sp) => `${sp.key} ${(day[sp.key] * 100).toFixed(1)}% -> ${(night[sp.key] * 100).toFixed(1)}% (want ${(want[sp.key] * 100).toFixed(1)}) of ${night[`${sp.key}N`]}`).join(', '))
  check(SPECIES.every((sp) => night[sp.key] > day[sp.key] * 1.3), 'and a lot more of them are lying down than at noon', SPECIES.map((sp) => `${sp.key} x${(night[sp.key] / day[sp.key]).toFixed(2)}`).join(', '))
  const dusk = share(() => 0.5)
  check(SPECIES.every((sp) => dusk[sp.key] > day[sp.key] && dusk[sp.key] < night[sp.key]), 'the settling is a ramp through the evening, not a switch at nightfall', SPECIES.map((sp) => `${sp.key} ${(dusk[sp.key] * 100).toFixed(1)}%`).join(', '))
  // The sky is read at the world second each phrase begins, so a chapter planned at noon for the coming night is a night's chapter.
  const asked = []
  const spy = make(11, { walk: plain, water: noWater }, (t) => { asked.push(t); return 1 })
  spy.place(0, 0)
  wake(spy)
  const c = alive(spy)[0]
  asked.length = 0
  const ch = spy.score.chapter(c.key, 5 * CHAPTER_S + chapterOf(0, c.key).offset + 1)
  check(asked.length > 10 && asked.every((t) => t >= ch.start && t <= ch.start + CHAPTER_S) && Math.min(...asked) === ch.start, 'and it is asked at the world second each phrase of the chapter begins, not at the second it is planned', `${asked.length} asks over ${ch.start} to ${ch.start + CHAPTER_S}`)
  spy.dispose()
  let threw = null
  try { make(11, undefined, 0.25) } catch (e) { threw = e.message }
  check(threw !== null && /dayness/.test(threw), 'a scalar in place of the clock\'s dayness function is refused', threw)
}

// --- a turn is a turn ------------------------------------------------------------
{
  const k = make(5)
  k.place(0, 0)
  wake(k)
  const dt = 1 / 60
  const c = alive(k).find((a) => a.sp.key === 'stag')
  // The hardest turn there is: a body asked to go back the way it came. Her head just past FLEE_M, so it is on a mesh rung.
  walkOn(k, c, c.sh + Math.PI, 'walk', 200)
  const from = c.phrase.from
  let worst = 0
  let frames = 0
  let prev = c.heading
  let crept = 0
  while (Math.abs(swing(c.heading, c.aim)) > 1e-9 && frames < 600) {
    step(k, from.x + FLEE_M + 1, GROUND + 1.6, from.z, dt)
    worst = Math.max(worst, Math.abs(swing(prev, c.heading)))
    prev = c.heading
    frames++
    if (Math.abs(swing(c.heading, c.aim)) > 1e-9) crept = Math.max(crept, Math.hypot(c.x - from.x, c.z - from.z))
  }
  check(frames >= Math.PI / TURN_RATE / dt && worst <= TURN_RATE * dt + 1e-9, 'an about-face is turned through, not snapped to', `${(frames * dt).toFixed(2)} s at up to ${(worst / dt).toFixed(2)} rad/s`)
  check(Math.abs(swing(c.heading, c.aim)) < 1e-9, 'and it arrives facing where it aimed', `${c.heading.toFixed(4)} of ${c.aim.toFixed(4)} rad`)
  check(crept <= c.speed * TICK_S + 1e-9, 'and makes no ground until it does: it pivots, it does not curve', `${crept.toFixed(4)} m before it faced its aim, a tick's stride being ${(c.speed * TICK_S).toFixed(4)}`)
  k.dispose()
}

// --- past FLEE_M she is furniture ------------------------------------------------
{
  const dt = 1 / 60
  // Her head straight up over the animal, past FLEE_M, so her horizontal position
  // is the animal's own and no tile shifts between runs: height is the only thing
  // that changes. Height is nothing to an animal but the rung it is drawn on and,
  // out past the near rungs, how often it is stepped -- so two lifts on the SAME
  // rung must trace identically, frame for frame, and on any rung every tick it
  // is stepped to must be the score's.
  const trace = (key, lift) => {
    const k = make(7)
    k.place(0, 0)
    const c = beside(k, key)
    const [hx, hz] = [c.x, c.z]
    const log = []
    const ticks = new Map()
    const lodSize = c.spawn.lodSize
    let rung = -1
    for (let f = 0; f < 900; f++) {
      step(k, hx, c.y + lift, hz, dt)
      if (f === 0) rung = c.lod
      log.push(`${c.act}/${c.clip}/${c.x.toFixed(6)}/${c.z.toFixed(6)}/${c.heading.toFixed(6)}`)
      ticks.set(c.rec.tick, `${c.act}/${c.clip}/${c.sx}/${c.sz}/${c.sh}`)
    }
    const out = { log, ticks, lodSize, rung, away: Math.hypot(c.x - c.home.x, c.z - c.home.z), moved: Math.hypot(c.x - hx, c.z - hz) }
    k.dispose()
    return out
  }
  const above = FLEE_M + 1
  const under = trace('stag', above)
  const eye = lodReach(under.lodSize, 0) * 0.85
  const over = trace('stag', eye)
  const at = under.log.findIndex((s, i) => s !== over.log[i])
  check(at < 0 && under.rung === over.rung, `fifteen seconds with her ${above} metres over it, and the stag does exactly what it would have done with her ${eye.toFixed(0)} metres up -- the same rung, and she is nothing to it either way`, at < 0 ? under.log[899].split('/').slice(0, 2).join('/') : `parted at frame ${at}: ${under.log[at]} vs ${over.log[at]}`)
  // And out along the whole ladder, where she IS far enough to change how often it is stepped: every tick it reaches is the same tick.
  for (let k = 0; k <= LOD_RUNGS; k++) {
    const t = trace('stag', lodReach(under.lodSize, k) * 0.9)
    const shared = [...t.ticks].filter(([tick]) => under.ticks.has(tick))
    const parted = shared.find(([tick, v]) => under.ticks.get(tick) !== v)
    check(t.rung === k && shared.length > 100 && !parted && t.away <= TETHER_M + 0.01, `on rung ${k}${k === LOD_RUNGS ? ', its card' : ''} every tick is the score's tick, and it is on its tether`, parted ? `parted at tick ${parted[0]}: ${parted[1]} vs ${under.ticks.get(parted[0])}` : `${shared.length} ticks alike, ${t.away.toFixed(2)} m from home, rung ${t.rung}`)
  }
  const hare = trace('hare', above)
  check(hare.away <= TETHER_M + 0.01, `and the hare ${above} metres under her has not bolted either`, `${hare.away.toFixed(2)} m from home in 15 s`)
}

// --- inside FLEE_M a wary one looks up, faces her and runs -------------------------
{
  const dt = 1 / 60
  for (const key of ['stag', 'hare']) {
    const k = make(7, { walk: plain, water: noWater })
    k.place(0, 0)
    const c = beside(k, key)
    still(k, c, 'graze', 'eat-loop')
    const [x0, z0] = [c.x, c.z]
    const her = { x: x0 + FLEE_M + 1, z: z0 }
    const run = (s, seen = new Set()) => { for (let f = 0; f < s * 60; f++) { step(k, her.x, c.y + 1.6, her.z, dt); seen.add(`${c.act}/${c.clip}`) } return seen }
    run(2)
    check(!c.live && c.act === 'graze' && c.x === x0 && c.z === z0, `${key}: her ${FLEE_M + 1} m off, it grazes on`, `${c.act}/${c.clip}`)
    k.pending()
    her.x = x0 + FLEE_M - 0.5
    run(3 / 60)
    check(c.live?.mode === 'flee' && c.live.by === null && c.act === 'startle' && c.clip === 'alert', `${key}: her inside ${FLEE_M} m, it looks up alert`, `${c.act}/${c.clip}`)
    run(STARTLE_S - 0.1)
    const facing = Math.abs(swing(c.heading, Math.atan2(-(her.z - c.z), her.x - c.x)))
    check(c.act === 'startle' && facing < 0.15 && Math.hypot(c.x - x0, c.z - z0) < 1e-6, `${key}: and turns on the spot to face her`, `${c.act}/${c.clip}, ${facing.toFixed(3)} rad off, moved ${Math.hypot(c.x - x0, c.z - z0).toFixed(3)} m`)
    k.voices([])
    const seen = run(2)
    const cried = k.voices([])
    check(c.sp.cry === undefined ? cried.length === 0 : cried.length === 1 && cried[0].sound === c.sp.cry.sound && cried[0].rule === c.sp.cry.rule, `${key}: ${c.sp.cry === undefined ? 'silent as it goes' : `one ${c.sp.cry.sound} as it bolts`}`, JSON.stringify(cried))
    const off = Math.hypot(c.x - her.x, c.z - her.z)
    check(seen.has(`flee/${c.sp.flee}`) && off > FLEE_M + 2, `${key}: then it ${c.sp.flee}s from her`, `${[...seen].join(' ')}; ${off.toFixed(1)} m off`)
    const owed = k.pending()
    check(owed.length >= 2 && owed.every((a) => a[0] === c.key && a[7] === 'flee' && a[8] === null), `${key}: owing the room flee anchors as it goes`, `${owed.map((a) => a[7]).join(' ')}`)
    const ran = c.stepStart
    for (let f = 0; f < 10 * 60 && c.live; f++) step(k, her.x, c.y + 1.6, her.z, dt)
    const last = k.pending()
    const clear = Math.hypot(c.x - her.x, c.z - her.z)
    check(!c.live && c.rejoin !== null && (clear > FLEE_CLEAR_M - 1 || c.rejoin.start - ran >= FLEE_S - TICK_S) && last.at(-1)[7] === 'rejoin' && last.slice(0, -1).every((a) => a[7] === 'flee'), `${key}: ${FLEE_CLEAR_M} m clear of her or ${FLEE_S} s run, it takes the rejoin and says so`, `${c.act}/${c.clip}, ${clear.toFixed(1)} m off after ${(c.rejoin?.start - ran).toFixed(1)} s, ${last.map((a) => a[7]).join(' ')}`)
    k.dispose()
  }
}

// --- unless she holds a carrot ------------------------------------------------------
{
  const dt = 1 / 60
  // On the flat plain, so following her crosses no pond and no crag. The carrot is a hands.js lure: a kind, where the hand is, and whose.
  for (const key of ['stag', 'hare']) {
    const eaten = []
    const k = make(7, { walk: plain, water: noWater }, null, (l) => { eaten.push(l); return true })
    k.place(0, 0)
    const c = beside(k, key)
    const sp = c.sp
    const carrot = { kind: 'carrot', x: 0, y: 0, z: 0, by: null }
    const head = { x: 0, z: 0 }
    const hold = (x, z, l = carrot) => { l.x = head.x = x; l.y = c.y + 1; l.z = head.z = z }
    // At its nose, a little up: what _atFace takes for its face.
    const toFace = (l) => { hold(c.sx + Math.cos(c.sh) * c.size * 0.5, c.sz - Math.sin(c.sh) * c.size * 0.5, l); l.y = c.y + c.size * 0.3 }
    const run = (s, lures, seen = new Set()) => { for (let f = 0; f < s * 60; f++) { step(k, head.x, c.y + 1.6, head.z, dt, lures); seen.add(`${c.act}/${c.clip}`) } return seen }
    const facing = (l) => Math.abs(swing(c.heading, Math.atan2(-(l.z - c.z), l.x - c.x)))
    still(k, c, 'graze', 'eat-loop')
    let [x0, z0] = [c.x, c.z]
    hold(x0 + FLEE_M + 1, z0)
    run(2, [carrot])
    check(!c.live && c.act === 'graze', `${key}: a carrot ${FLEE_M + 1} m off is nothing to it`, `${c.act}/${c.clip}`)
    head.x = x0 + FLEE_M - 1
    run(2, [{ kind: 'fish', x: head.x, y: c.y + 1, z: z0, by: null }])
    check(c.live?.mode === 'flee', `${key}: nor is a fish: inside ${FLEE_M} m with one, it startles as if she held nothing`)
    still(k, c, 'graze', 'eat-loop')
    ;[x0, z0] = [c.x, c.z]
    k.pending()
    hold(x0 + FLEE_M - 1, z0)
    run(3 / 60, [carrot])
    const wentLive = timeOf(k)
    check(c.live?.mode === 'lure' && c.lure === carrot && c.live.by === null && c.act === 'notice' && c.clip === 'alert', `${key}: inside ${FLEE_M} m with a carrot, it looks up and does not run`, `${c.act}/${c.clip}`)
    let seen = run(8, [carrot])
    const moved = () => Math.hypot(c.x - x0, c.z - z0)
    check(c.live?.mode === 'lure' && seen.has('gaze/idle') && seen.has('gaze/alert') && ![...seen].some((s) => s.startsWith('follow') || s.startsWith('flee')) && moved() < 1e-6 && facing(carrot) < 0.15, `${key}: eight seconds on it stands where it was, facing the carrot, idle and alert by turns`, `${[...seen].join(' ')}; moved ${moved().toFixed(3)} m, ${facing(carrot).toFixed(3)} rad off`)
    const owed = k.pending()
    const ticks = owed.map((a) => tickOf(a[1]))
    const every = Math.round(ANCHOR_S * TICK_HZ)
    check((owed.length === 8 || owed.length === 9) && ticks.every((t, i) => i === 0 || t - ticks[i - 1] === every) && owed[0][1] <= wentLive + TICK_S + 1e-9 && owed.every((a) => a.length === 9 && a[0] === c.key && a[7] === 'lure' && a[8] === null && a[6] === -1 && onTicks(a[1])), `${key}: owing the room [key, T, x, y, z, heading, -1, "lure", null] every ${ANCHOR_S} s on the tick grid`, `${owed.length} anchors, ticks ${ticks.join(' ')}`)
    check(k.anchored.get(c.key) === owed[owed.length - 1], `${key}: and keeping its latest as the room's`)
    hold(carrot.x + 4, z0)
    seen = run(4, [carrot])
    check(c.live?.mode === 'lure' && moved() < 1e-6, `${key}: carried four metres further, it waits for her and does not follow`, `${[...seen].join(' ')}`)
    // Someone else's carrot at its face: it begs and is not given it.
    const theirs = { kind: 'carrot', x: 0, y: 0, z: 0, by: 7 }
    toFace(theirs)
    seen = run(8, [theirs])
    check(seen.has('beg/eat-loop') && eaten.length === 0 && c.live?.mode === 'lure', `${key}: a peer's carrot at its face, it begs at it and it is not its to eat`, `${[...seen].join(' ')}`)
    k.voices([])
    k.pending()
    toFace(carrot)
    seen = new Set()
    for (let f = 0; f < 8 * 60 && c.live?.mode !== 'tame'; f++) run(1 / 60, [carrot], seen)
    const said = k.voices([])
    check(c.live?.mode === 'tame' && eaten.length === 1 && eaten[0] === carrot && c.act === 'eat' && c.lure === null, `${key}: her own carrot at its face, it eats it out of her hand and is tame`, `${c.act}/${c.clip}; ${eaten.length} eaten`)
    check(said.length === 1 && said[0].sound === sp.call.sound && said[0].rate >= sp.call.rate[0] && said[0].rate <= sp.call.rate[1] && Math.abs(said[0].x - c.sx) < 1, `${key}: with a contented ${sp.call.sound} from where it stands`, JSON.stringify(said))
    run(2 / 60, [])
    check(k.pending().some((a) => a[7] === 'tame' && a[8] === null), `${key}: and the room hears it tame at once`)
    const ate = timeOf(k)
    for (let f = 0; f < 20 * 60 && c.act === 'eat'; f++) run(1 / 60, [], seen)
    check(seen.has('eat/eat-loop') && seen.has('eat/eat-up') && c.act !== 'eat' && k.voices([]).length === 1, `${key}: it chews, lifts its head, and calls again`, `${[...seen].join(' ')} in ${(timeOf(k) - ate).toFixed(1)} s`)
    const [x1, z1] = [c.x, c.z]
    head.x += 10
    seen = run(10, [])
    const gap = Math.hypot(head.x - c.x, head.z - c.z)
    check(c.live?.mode === 'tame' && [...seen].some((s) => s.startsWith('follow/')) && gap <= sp.heel + 0.1 && Math.hypot(c.x - x1, c.z - z1) > 6, `${key}: she walks ten metres off and it follows her, to ${sp.heel} m of her`, `${[...seen].join(' ')}; ${gap.toFixed(2)} m off her`)
    if (key === 'stag') {
      // She goes past LURE_FORGET_M: it is wild again, owing the room where that left it, and the rejoin walks it to the score.
      k.pending()
      const [x2, z2] = [c.sx, c.sz]
      const t2 = timeOf(k)
      head.x = c.x + LURE_FORGET_M + 1
      run(4, [])
      const last = k.pending()
      check(!c.live && c.rejoin !== null && !['notice', 'follow', 'gaze', 'beg', 'eat'].includes(c.act), `her past ${LURE_FORGET_M} m, it forgets her and takes the rejoin`, `${c.act}/${c.clip}`)
      check(last.length === 1 && last[0][7] === 'rejoin' && last[0][8] === null && last[0][2] === x2 && last[0][4] === z2 && last[0][1] > t2 && last[0][1] <= t2 + TICK_S + 1e-9, 'owing the room one rejoin anchor from where it left her, and nothing more', JSON.stringify(last.map((a) => a.map((v) => (typeof v === 'number' ? +v.toFixed(3) : v)))))
      const rj = c.rejoin
      const ch = k.score.chapter(c.key, rj.end)
      const join = ch.phrases[ch.starts.findIndex((s) => Math.abs(ch.start + s - rj.end) < 1e-9)]
      const stand = rj.phrases[rj.phrases.length - 1]
      check(join !== undefined && rj.start === last[0][1] && stand.kind === 'stand' && stand.to.x === join.from.x && stand.to.z === join.from.z && stand.to.heading === join.from.heading && (rj.phrases.length === 1 || (rj.phrases.length === 2 && rj.phrases[0].mps !== undefined && rj.phrases[0].to === stand.from)), 'the rejoin is a walk to the start pose of a phrase of the score, and a stand there, turned to its heading, until it starts', `${rj.phrases.map((p) => `${p.kind} ${p.dur.toFixed(2)} s`).join(', ')} to phrase ${ch.phrases.indexOf(join)}`)
      const before = Math.hypot(x2 - stand.to.x, z2 - stand.to.z)
      const after = Math.hypot(c.x - stand.to.x, c.z - stand.to.z)
      check(after < 1e-6 || after <= before - 1, 'and four seconds on it is nearer that pose', `${after.toFixed(1)} m off, from ${before.toFixed(1)}`)
      hold(c.x + 4, c.z)
      run(1, [carrot])
      check(c.live?.mode === 'lure', 'a carrot four metres off has it again', `${c.live?.mode} ${c.act}/${c.clip}`)
      hold(c.x + LURE_FORGET_M + 1, c.z)
      run(1, [carrot])
      check(!c.live, `and carried ${LURE_FORGET_M + 1} m off in a bound, it is given up`)
    }
    k.dispose()
  }

  // A fox is not wary: it wants a fish or a crab, and comes to its own standoff for one.
  const h = make(7, { walk: plain, water: noWater })
  h.place(0, 0)
  const x = beside(h, 'fox')
  const fish = { kind: 'fish', x: x.x + LURE_M - 0.2, y: x.y + 1, z: x.z }
  still(h, x, 'rest', 'lie')
  const trots = new Set()
  for (let f = 0; f < 8 * 60; f++) { step(h, fish.x, x.y + 1.6, fish.z, dt, [fish]); trots.add(`${x.act}/${x.clip}`) }
  const off = Math.hypot(fish.x - x.x, fish.z - x.z)
  check(x.live && trots.has('follow/trot') && off <= x.sp.standoff + 0.1 && x.speed === 0, `a fox at rest comes to a fish at a trot and stops ${x.sp.standoff} m short`, `${[...trots].join(' ')}; ${off.toFixed(2)} m off`)
  h.dispose()
}

// --- and the room sees it -----------------------------------------------------------
// Two clients on the one clock: a's hand holds the carrot, b hears a's anchors as
// client 7's, and b's copy of the stag has to be a's copy of the stag. b's own
// head stands well past FLEE_M, so nothing but a moves b's stag.
{
  const dt = 1 / 60
  const a = make(7, { walk: plain, water: noWater })
  const b = make(7, { walk: plain, water: noWater })
  a.place(0, 0)
  b.place(0, 0)
  const ca = beside(a, 'stag')
  const cb = beside(b, 'stag')
  check(ca.key === cb.key && ca.home.x === cb.home.x && cb.live === null, 'both clients wake the same stag, by key, at the same home')
  const carrot = { kind: 'carrot', x: ca.x + FLEE_M - 1, y: ca.y + 1, z: ca.z, by: null }
  const aHead = { x: carrot.x, z: carrot.z }
  const bHead = { x: ca.home.x - 20, z: ca.home.z }
  const relay = (to, from, by = 7) => { let n = 0; for (const anchor of from.pending()) { to.apply([...anchor.slice(0, 8), by], timeOf(to)); n++ } return n }
  // Both step together; every anchor a owes is applied to b the frame it is owed.
  const together = (s, lures, onFrame) => {
    for (let f = 0; f < s * 60; f++) {
      step(a, aHead.x, ca.y + 1.6, aHead.z, dt, lures)
      step(b, bHead.x, cb.y + 1.6, bHead.z, dt)
      if (onFrame) onFrame()
    }
  }
  together(1, [carrot], () => relay(b, a))
  check(ca.live?.mode === 'lure' && ca.live.by === null && cb.live?.mode === 'lure' && cb.live.by === 7 && cb.live.anchor !== null && cb.lure === null, 'a\'s stag is live at her carrot; a second on, b\'s is live at client 7\'s, on the anchor, with no lure of its own', `b: ${cb.act}/${cb.clip} by ${cb.live?.by}`)
  check(cb.act === 'notice' && cb.clip === 'alert' && b.pending().length === 0, 'and stands alert there, owing the room nothing: the lurer is the authority', `${cb.act}/${cb.clip}`)
  // a holds the carrot to its face: a's stag eats it and is tame, and b hears so.
  b.voices([])
  for (let f = 0; f < 10 * 60 && ca.live?.mode !== 'tame'; f++) {
    carrot.x = aHead.x = ca.sx + Math.cos(ca.sh) * ca.size * 0.5
    carrot.z = aHead.z = ca.sz - Math.sin(ca.sh) * ca.size * 0.5
    carrot.y = ca.y + ca.size * 0.3
    together(1 / 60, [carrot], () => relay(b, a))
  }
  for (let f = 0; f < 20 * 60 && ca.act === 'eat'; f++) together(1 / 60, [], () => relay(b, a))
  check(ca.live?.mode === 'tame' && cb.live?.mode === 'tame' && cb.live.by === 7 && b.voices([]).length === 1, 'fed from a\'s hand, a\'s stag is tame, and b\'s is too, with the call heard there', `a ${ca.live?.mode}, b ${cb.live?.mode} ${cb.act}/${cb.clip}`)
  // She walks eight metres: a's stag follows her, b's follows the anchors.
  aHead.x += 8
  let apart = 0
  together(12, [], () => { relay(b, a); apart = Math.max(apart, Math.hypot(ca.x - cb.x, ca.z - cb.z)) })
  const gapAB = Math.hypot(ca.x - cb.x, ca.z - cb.z)
  check(Math.hypot(ca.x - aHead.x, ca.z - aHead.z) < ca.sp.heel + 0.1 && gapAB < 0.5 && apart < 8, 'she walks eight metres, and b\'s copy has kept within eight metres of a\'s on the way and is within half a metre once a\'s has stopped a while', `${apart.toFixed(2)} m apart at most, ${gapAB.toFixed(2)} m now`)
  check(Math.abs(swing(ca.heading, cb.heading)) < 0.2, 'facing the way a\'s faces', `${Math.abs(swing(ca.heading, cb.heading)).toFixed(3)} rad apart`)
  // The relay goes quiet: b's copy keeps to the last anchor for ANCHOR_STALE_S, then gives it up on its own and rejoins, owing nothing.
  const T = cb.live.anchor[1]
  while (timeOf(b) + dt < T + ANCHOR_STALE_S - 0.05) together(1 / 60, [])
  check(cb.live?.mode === 'tame', `b's copy keeps to it through ${ANCHOR_STALE_S} s of silence`, `${cb.act}/${cb.clip} at ${(timeOf(b) - T).toFixed(2)} s`)
  together(0.3, [])
  check(cb.live === null && cb.rejoin !== null && b.pending().length === 0, `and past ${ANCHOR_STALE_S} s gives it up for the rejoin, owing the room nothing`, `${cb.act}/${cb.clip}`)
  // a walks off past LURE_FORGET_M: its rejoin anchor puts b's copy on the very same rejoin, and the two agree to the bit from there.
  a.pending()
  aHead.x = ca.x + LURE_FORGET_M + 1
  let last = []
  for (let f = 0; f < 5 && last.length === 0; f++) { together(1 / 60, []); last = a.pending() }
  check(last.length === 1 && last[0][7] === 'rejoin', 'a\'s stag owes one rejoin anchor when she leaves it')
  b.apply([...last[0].slice(0, 8), 7], timeOf(b))
  check(cb.rejoin !== null && cb.rejoin.start === ca.rejoin.start && cb.rejoin.end === ca.rejoin.end && cb.rejoin.phrases.length === ca.rejoin.phrases.length && cb.rejoin.phrases.every((p, i) => p.dur === ca.rejoin.phrases[i].dur && p.to.x === ca.rejoin.phrases[i].to.x), 'applied on b, the anchor derives the same rejoin: the same walk, the same wait, the same phrase to join', `${cb.rejoin?.phrases.map((p) => `${p.kind} ${p.dur.toFixed(2)} s`).join(', ')}`)
  // Both heads in one place, so both are stepped alike from here.
  aHead.x = bHead.x
  aHead.z = bHead.z
  const same = () => [ca, cb].map((c) => [c.x, c.z, c.heading, c.sx, c.sz, c.sh, c.rec.tick, c.act, c.clip, c.stepStart, c.rejoin !== null].join('/'))
  together(5, [])
  let [pa, pb] = same()
  check(pa === pb && ca.rejoin !== null, 'five seconds on both draw the stag at the same place in the same step of its rejoin', pa === pb ? pa.split('/').slice(6).join('/') : `${pa} vs ${pb}`)
  jump(a, ca.rejoin.end + 20)
  jump(b, cb.rejoin.end + 20)
  together(1, [])
  ;[pa, pb] = same()
  check(pa === pb && ca.rejoin === null && cb.rejoin === null, 'and twenty seconds past the rejoin both have it back on the score, alike', pa === pb ? pa.split('/').slice(6).join('/') : `${pa} vs ${pb}`)
  // a walks up on it with nothing in hand: it flees, and b's copy runs with it.
  a.pending()
  aHead.x = ca.sx + FLEE_M - 1
  aHead.z = ca.sz
  together(STARTLE_S + 1.5, [], () => relay(b, a))
  check(ca.live?.mode === 'flee' && cb.live?.mode === 'flee' && cb.live.by === 7 && cb.clip === 'run' && Math.hypot(ca.x - cb.x, ca.z - cb.z) < 1.5, 'startled by a, a\'s stag runs, and b\'s runs with it', `b ${cb.live?.mode} ${cb.act}/${cb.clip}, ${Math.hypot(ca.x - cb.x, ca.z - cb.z).toFixed(2)} m apart`)
  // What the room's map does for a client that was not there: kept while the animal sleeps and used the frame it wakes.
  if (chapterOf(timeOf(b) + 15, ca.key).start !== chapterOf(timeOf(b), ca.key).start) jump(b, timeOf(b) + 20)
  // Her head ten kilometres up, so the tiles stay and every animal on them is past its forget range; sleep waits on each body's dissolve, so a few seconds of it.
  const asleep = (of) => { for (let f = 0; f < 900 && of.byKey.size > 0; f++) step(of, ca.home.x, 1e4, ca.home.z, dt); return of.byKey.size === 0 }
  check(asleep(b) && cb.spawn === null, 'her head ten kilometres up, b\'s stag is put back to sleep')
  const T0 = timeOf(b)
  const lureAnchor = [ca.key, T0, ca.home.x + 5, ca.y, ca.home.z + 5, 1.2, -1, 'lure', 7]
  b.apply(lureAnchor, timeOf(b))
  check(b.anchored.get(ca.key) === lureAnchor, 'an anchor for a sleeping animal is kept')
  step(b, ca.home.x, GROUND + 1.6, ca.home.z, 1 / 60)
  const woke = b.byKey.get(ca.key)
  check(woke !== undefined && woke.live !== null && woke.live.by === 7 && woke.live.anchor === lureAnchor && woke.sx === lureAnchor[2] && woke.sz === lureAnchor[4] && woke.sh === lureAnchor[5], `and woken within ${ANCHOR_STALE_S} s of a lure anchor, the animal is live at the anchor's pose, at client 7's hand`, `${woke?.act}/${woke?.clip} at ${woke?.sx.toFixed(2)},${woke?.sz.toFixed(2)}`)
  asleep(b)
  jump(b, T0 + ANCHOR_STALE_S + 0.5)
  step(b, ca.home.x, GROUND + 1.6, ca.home.z, 1 / 60)
  const stale = b.byKey.get(ca.key)
  check(stale !== undefined && stale.live === null && stale.rejoin !== null && stale.rejoin.start === T0 + ANCHOR_STALE_S, `woken after one has gone stale, it is on the rejoin from ${ANCHOR_STALE_S} s past the anchor -- when every client gave the lure up`, `rejoin from ${stale?.rejoin?.start} of anchor ${T0}`)
  asleep(b)
  const old = [ca.key, chapterOf(timeOf(b), ca.key).start - 1, 0, 0, 0, 0, -1, 'rejoin', 7]
  b.apply(old, timeOf(b))
  step(b, ca.home.x, GROUND + 1.6, ca.home.z, 1 / 60)
  const planned = b.byKey.get(ca.key)
  check(planned !== undefined && planned.live === null && planned.rejoin === null, 'an anchor from before the chapter began is nothing: the chapter turn put the animal home, and it is on its score', `${planned?.act}/${planned?.clip}`)
  // What it will not take.
  const size = b.anchored.size
  b.apply([ca.key, timeOf(b), 1, 2, 3, 4, -1, 'lure', null], timeOf(b))
  check(b.anchored.size === size && b.anchored.get(ca.key) === old && planned.live === null, 'its own anchors echoed back (by null) are ignored')
  const refused = (anchor) => { try { b.apply(anchor, timeOf(b)); return '' } catch (e) { return e.message } }
  check(/mode/.test(refused([ca.key, timeOf(b), 0, 0, 0, 0, -1, 'bolt', 7])) && /time/.test(refused([ca.key, NaN, 0, 0, 0, 0, -1, 'lure', 7])), 'a mode it does not know, or an anchor with no time, is refused out loud')
  a.dispose()
  b.dispose()
}

// --- a standing body puts its feet on the ground -----------------------------------
//
// A tilted plain, and one of each species stood on it facing uphill. Idle, each
// foot is solved to the ground under it (puppet.js FootIK); walking, the clip is
// left exactly alone; turned on the spot, the ground is read again.
{
  const TILT = 0.15
  const tilted = { heightAt: (x, z) => GROUND + TILT * z, normalAt: (x, z, eps, out = { x: 0, y: 1, z: 0 }) => { const len = Math.hypot(TILT, 1); out.x = 0; out.y = 1 / len; out.z = -TILT / len; return out } }
  const t = calm(make(11, { walk: tilted, water: noWater }))
  t.place(0, 0)
  wake(t)
  const dt = 1 / 60
  // Her head over it, on the top rung, for `s` seconds.
  const over = (c, s) => { for (let f = 0; f < Math.round(s / dt); f++) step(t, c.x, c.y + 1.6, c.z, dt) }
  // Each foot joint in the world: its height over the ground under it, and the bend at its knee.
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3()
  const feet = (c) => {
    // A bone's world matrix is creature-space (the rig is detached); the group puts it in the world.
    const g = c.puppet.group.matrix
    return c.puppet.ik.legs.map((l) => {
      A.setFromMatrixPosition(l.A.matrixWorld).applyMatrix4(g); B.setFromMatrixPosition(l.B.matrixWorld).applyMatrix4(g); C.setFromMatrixPosition(l.C.matrixWorld).applyMatrix4(g)
      return { id: l.id, hover: C.y - tilted.heightAt(C.x, C.z), knee: Math.acos(A.sub(B).normalize().dot(C.sub(B).normalize())) }
    })
  }
  const restKnee = Math.acos(new THREE.Vector3(-0.12, 0.3, 0).normalize().dot(new THREE.Vector3(-0.12, -(LEG_HIP_Y - 0.3 - LEG_FOOT_Y), 0).normalize()))
  const identity = new THREE.Quaternion()
  check([...PLANTED].sort().join() === 'alert,eat-down,eat-loop,eat-up,idle', 'the clips whose feet stay put are idle, alert and the graze -- a dig lifts a forefoot, a sit and a lie fold, and no gait plants', [...PLANTED].join(' '))
  for (const key of ['stag', 'fox', 'hare']) {
    const c = beside(t, key)
    c.sh = -Math.PI / 2
    still(t, c, 'stand', 'idle')
    over(c, 1)
    const own = LEG_FOOT_Y * c.sp.asset.height * c.k
    const rise = 0.6 * c.sp.asset.span * c.k * TILT
    const up = feet(c)
    check(c.clip === 'idle' && c.speed === 0 && c.puppet?.planted && c.puppet.ik.w === 1, `a ${key} stood idle facing up a ${((Math.atan(TILT) * 180) / Math.PI).toFixed(0)}-degree slope has its feet planted`)
    check(up.every((f) => Math.abs(f.hover - own) < 1e-3), `and a second later each of its four feet stands exactly its clip's own ${(own * 100).toFixed(1)} cm over the ground under it, which rises ${(rise * 100).toFixed(0)} cm from its hind feet to its fore`, up.map((f) => `${f.id} ${(f.hover * 100).toFixed(2)}`).join(' '))
    check(up.filter((f) => f.id[0] === 'F').every((f) => f.knee < restKnee - 0.02) && up.filter((f) => f.id[0] === 'H').every((f) => f.knee > restKnee + 0.02), 'its fore knees folded and its hind knees opened off the clip to get there', up.map((f) => `${f.id} ${((f.knee * 180) / Math.PI).toFixed(1)}`).join(' ') + ` of ${((restKnee * 180) / Math.PI).toFixed(1)}`)
    // Walking, the solver lets go and the mixer alone owns the leg: the stand-in's clips never touch a leg, so every hip and knee is back at rest.
    walkOn(t, c, c.sh)
    over(c, 0.5)
    const walking = feet(c)
    check(c.speed > 0 && !c.puppet.planted && !c.puppet.ik.active && !c.puppet.ik.dirty && c.puppet.ik.legs.every((l) => l.A.quaternion.equals(identity) && l.B.quaternion.equals(identity)) && walking.every((f) => Math.abs(f.knee - restKnee) < 1e-9), `walking off, ${c.clip}, half a second later its legs are the clip's exactly, whatever the ground under each foot`, walking.map((f) => `${f.id} ${(f.hover * 100).toFixed(1)}`).join(' '))
    // Stood again and turned on the spot, past REPLANT: the ground is read under where the feet are now, and they land on it again.
    still(t, c, 'stand', 'idle')
    over(c, 1)
    const first = c.puppet.plantHeading
    still(t, c, 'stand', 'idle', c.sh + REPLANT * 3)
    over(c, 3)
    const turned = feet(c)
    // Between re-plants a foot's ground is the one read up to REPLANT ago: at most that swing, at the foot's radius, down the tilt.
    const stale = Math.hypot(0.3 * c.sp.asset.span, 0.3 * c.sp.asset.width) * c.k * REPLANT * TILT
    check(Math.abs(swing(c.heading, c.aim)) < 1e-6 && c.puppet.plantHeading !== first && Math.abs(swing(c.puppet.plantHeading, c.heading)) <= REPLANT && turned.every((f) => Math.abs(f.hover - own) < stale + 1e-3), `turned ${(REPLANT * 3).toFixed(2)} rad on the spot, it has read the ground again and every foot stands on it, to within the ${(stale * 100).toFixed(1)} cm a swing short of REPLANT can move the ground under a foot`, `planted at ${first.toFixed(2)}, again at ${c.puppet.plantHeading.toFixed(2)}, facing ${c.heading.toFixed(2)}; ${turned.map((f) => `${f.id} ${((f.hover - own) * 100).toFixed(2)}`).join(' ')}`)
  }
  t.dispose()
}

// --- drawn, or not drawn ---------------------------------------------------------
{
  w.place(0, 0)
  wake(w)
  const c = alive(w).find((a) => a.sp.key === 'stag')
  // Straight up over it, so the distance is exactly d and the tiles do not move; dt 0, so nothing walks out from under the test.
  const at = (d, frames = 2, dt = 0) => {
    for (let f = 0; f < frames; f++) step(w, c.x, c.y + d, c.z, dt)
    return c.lod
  }
  // Enough frames at a real dt for every dissolve to finish: a tier change, an appearance or a vanishing takes LOD_FADE_S, and a puppet is not back in the pool until it has.
  const settle = (d) => at(d, Math.ceil(LOD_FADE_S * 60) + 2, 1 / 60)
  // Every distance here is read off the animal's own body, because that is what the ladder is a ratio of. Held aside: past the cull the slot is let go and the spawn with it.
  // Off the LIVE spawn each time: past the card the slot is let go, and the next
  // animal to take it has its own body and so its own ladder. Out there the slot
  // is empty and the last body it held is the one the distances still mean.
  let lodSize = c.spawn.lodSize
  const size = () => (c.spawn ? (lodSize = c.spawn.lodSize) : lodSize)
  const reach = (k) => lodReach(size(), k)
  const expect = (d) => critterTier(size(), d, -1, CARD_RUNGS)
  const close = reach(0) / 2
  const near = settle(close)
  check(near === 0 && expect(close) === 0 && c.puppet && w.batch.children.includes(c.puppet.group), `${close.toFixed(0)} metres off -- half of what the top rung holds -- the stag is a puppet in the scene, on the top rung`)
  check(c.puppet.current.getClip().name === c.clip && c.puppet.current.isRunning(), 'playing what it is doing', c.clip)
  {
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
    c.puppet.group.matrix.decompose(p, q, s)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    check(p.distanceTo(new THREE.Vector3(c.x, c.y, c.z)) < 1e-6 && Math.abs(s.x - c.k) < 1e-9, 'standing where the animal is, at its own size', `scale ${s.x.toFixed(3)}`)
    // The moor rolls under it -- its probed normal leans -- and the body stands on the world vertical regardless.
    const lean = Math.acos(Math.min(1, c.ny))
    check(lean > 1e-6 && up.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-9, 'upright on the world vertical, on ground that leans under it', `ground leans ${((lean * 180) / Math.PI).toFixed(2)} deg`)
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
    check(Math.abs(fwd.y) < 1e-9 && Math.abs(Math.atan2(-fwd.z, fwd.x) - Math.atan2(Math.sin(c.heading), Math.cos(c.heading))) < 1e-6, 'and its body faces its heading, level', `${c.heading.toFixed(2)} rad`)
  }
  // A stag this far off is still a walking puppet, on the bottom mesh rung -- the card is a rung PAST this, not a substitute for it.
  const out = reach(LOD_RUNGS - 1) * 0.9
  const mid = settle(out)
  check(mid === expect(out) && mid === LOD_RUNGS - 1 && c.puppet, `and ${out.toFixed(0)} metres off, just inside the mesh cull, it is still its own animated puppet on the last rung, not a photograph of one`)
  {
    const inSight = alive(w).filter((a) => a.lod < LOD_RUNGS)
    const cardMeshes = w.species.map((s) => s.cardMesh)
    const lent = w.batch.children.filter((o) => !cardMeshes.includes(o))
    // Everything else in the batch is a body on its way out: one an animal still holds while it dissolves, or one left behind when its tile unloaded.
    const owned = new Set([...alive(w).filter((a) => a.puppet).map((a) => a.puppet.group), ...w.fading.map((f) => f.puppet.group)])
    check(inSight.length > 0 && inSight.every((a) => a.puppet) && cardMeshes.every((m) => w.batch.children.includes(m)) && lent.length === owned.size && lent.every((g) => owned.has(g)),
      'every animal on a mesh rung wears a puppet, and the batch draws those, the bodies still dissolving, and the three card meshes', `${inSight.length} on a mesh of ${alive(w).length} alive, ${lent.length} puppets out, ${w.starved} starved`)
  }
  // Out past the meshes and onto the card: one more rung, reaching twice as far.
  const card = reach(LOD_RUNGS) * 0.9
  check(settle(card) === LOD_RUNGS && expect(card) === LOD_RUNGS && !c.puppet, `${card.toFixed(0)} metres off, past the last mesh rung, the stag has given its puppet back`)
  {
    const sp = w.species.find((s) => s.key === 'stag')
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
    // The instance matrix is a Float32Array, so a world coordinate in the hundreds comes back rounded.
    const i = [...Array(sp.cardN).keys()].find((n) => { sp.cardMesh.getMatrixAt(n, m); m.decompose(p, q, s); return p.distanceTo(new THREE.Vector3(c.x, c.y, c.z)) < 1e-3 })
    check(i !== undefined && sp.cardMesh.count === sp.cardN && sp.cardN > 0, 'and taken an instance in its species card mesh instead, standing where the animal stands', `${sp.cardN} cards drawn`)
    check(Math.abs(s.x - c.k) < 1e-6, 'at its own size, so a herd of cards is as varied as the herd of meshes was')
    check(sp.cardFade.array[i] === 1, 'and settled: the whole card is drawn, with no dither left in it', `fade ${sp.cardFade.array[i]}`)
  }
  const far = reach(LOD_RUNGS) * 4
  check(settle(far) === CARD_RUNGS && expect(far) === CARD_RUNGS && !c.puppet && w.species.find((s) => s.key === 'stag').cardN === 0, `${far.toFixed(0)} metres off, four times the card's reach, it is not drawn at all`)
  check(w.species.every((sp) => sp.freePuppets.length + sp.puppets.filter((p) => p.group.parent === w.batch).length === PUPPETS), 'the pools balance')
  at(close, 4)
  const t = c.puppet.mixer.time
  at(close, 10, 1 / 60)
  check(c.puppet && Math.abs(c.puppet.mixer.time - t - 10 / 60) < 1e-9, "a puppet's mixer advances with the frames", `${(c.puppet.mixer.time - t).toFixed(4)} s in ten`)
  // THE POSE CADENCE (puppet.js POSE_EVERY), which is the one saving the mesh
  // ladder does NOT give us: three re-uploads a bone texture once a frame for
  // every skeleton it draws, whichever rung that skeleton is drawn on, so a
  // rung-3 stag skinning as dearly as a rung-0 one unless the pose is skipped.
  {
    const sampled = (k) => {
      const d = reach(k) * 0.75
      settle(d)
      const p = c.puppet
      if (!p || p.tier !== k) throw new Error(`check-wildlife: wanted rung ${k} for the cadence, the stag is on ${p ? p.tier : 'a card'}`)
      // Standing in for the renderer's own bone texture: Skeleton.update raises
      // that flag, and raising it IS the upload.
      const tex = { needsUpdate: false }
      p.skeleton.boneTexture = tex
      // Nothing drew it while it settled, so the first draw fills the texture whatever the cadence; that one is the next block's, not this count's.
      p.skeleton.update()
      tex.needsUpdate = false
      const t0 = p.mixer.time
      let uploads = 0
      for (let f = 0; f < 24; f++) {
        at(d, 1, 1 / 60)
        p.skeleton.update() // what WebGLObjects.update does once a frame for every skeleton drawn
        if (tex.needsUpdate) { uploads++; tex.needsUpdate = false }
      }
      p.skeleton.boneTexture = null
      return { uploads, played: p.mixer.time - t0 }
    }
    const top = sampled(0)
    const last = sampled(LOD_RUNGS - 1)
    check(top.uploads === 24 && last.uploads === 24 / POSE_EVERY[LOD_RUNGS - 1], `the top rung re-poses every frame and the last one every ${POSE_EVERY[LOD_RUNGS - 1]}th, which is a bone texture built and uploaded that many times less`, `${top.uploads} and ${last.uploads} uploads in 24 frames`)
    check(Math.abs(top.played - 24 / 60) < 1e-9 && Math.abs(last.played - 24 / 60) < 1e-9, 'and the skipped time is banked and spent whole, so a clip sampled every fourth frame still plays at its own speed -- a lower sample rate, not a slower animal', `${last.played.toFixed(4)} s of ${(24 / 60).toFixed(4)}`)
    const p = c.puppet
    // A POSE FRAME SPENT OUT OF VIEW STILL REACHES THE TEXTURE. The renderer
    // runs skeleton.update only for a body that passed the frustum test, so a
    // new clip whose pose frame lands behind her would otherwise draw the clip
    // before it (or, fresh from the pool, nothing) until the next pose frame.
    {
      const tex = { needsUpdate: false }
      p.skeleton.boneTexture = tex
      const drawn = () => { p.skeleton.update(); const up = tex.needsUpdate; tex.needsUpdate = false; return up }
      p.play(c.clip, p.cue + 1000) // a fresh cue re-cues the same clip
      p.step(1 / 60) // the pose frame, culled: the renderer never calls update
      const wasPosed = p.posed
      p.step(1 / 60)
      const onHeld = !p.posed && drawn()
      p.step(1 / 60)
      const again = !p.posed && drawn()
      p.skeleton.boneTexture = null
      check(wasPosed && onHeld && !again, 'a clip change whose pose frame the renderer culled fills the bone texture on the first frame it does draw, held or not, and only that once', `posed ${wasPosed}, first held frame uploaded ${onHeld}, next ${again}`)
    }
    {
      const sphere = p.meshes[0].boundingSphere
      const geo = p.meshes[0].geometry
      if (!geo.boundingSphere) geo.computeBoundingSphere()
      const holds = sphere.radius >= sphere.center.distanceTo(geo.boundingSphere.center) + geo.boundingSphere.radius
      check(p.meshes.every((m) => m.frustumCulled && m.boundingSphere === sphere) && holds,
        'every rung is frustum-culled on one explicit sphere round the rest bounds: a body behind her drops its bone-texture upload along with its draw, and SkinnedMesh.computeBoundingSphere -- which CPU-skins every vertex -- is never reached', `r ${sphere.radius.toFixed(2)} m over a ${geo.boundingSphere.radius.toFixed(2)} m body`)
    }
    // A HELD FRAME SLIDES THE POSE ON. The rig hangs under nothing, so its
    // world matrices are creature-space and the bone texture holds the pose
    // alone; the group's matrix places it and is written every frame, held or
    // not. A body that hopped along at its pose cadence was what the headset
    // could not live with.
    {
      check(p.rig.parent === null && p.bones[0] === p.rig && p.meshes.every((m) => m.bindMode === THREE.DetachedBindMode && m.bindMatrix.equals(new THREE.Matrix4()) && m.bindMatrixInverse.equals(new THREE.Matrix4())),
        'the rig is detached -- under no node, on an identity bind -- so a bone matrix is the pose and the group matrix is the place')
      const d = reach(LOD_RUNGS - 1) * 0.75
      // Put it on a long roam first: left to the roll it can graze through the whole window.
      walkOn(w, c, c.sh)
      let tested = false, moved = false, held = false
      for (let f = 0; f < 600 && !tested; f++) {
        const was = p.group.matrix.elements.slice()
        const bones = p.bones.map((b) => b.matrixWorld.elements.slice())
        const x0 = c.x, z0 = c.z
        at(d, 1, 1 / 60)
        // A frame the animal walked through AND held its pose on: the two together are what the promise is about.
        if (!p.posed && Math.hypot(c.x - x0, c.z - z0) > 1e-6) {
          tested = true
          moved = Math.abs(p.group.matrix.elements[12] - c.x) < 1e-9 && Math.abs(p.group.matrix.elements[14] - c.z) < 1e-9 && !p.group.matrix.elements.every((v, n) => v === was[n])
          held = p.bones.every((b, i) => b.matrixWorld.elements.every((v, n) => v === bones[i][n]))
        }
      }
      check(tested && moved && held, 'and on a held frame the group matrix follows the animal while every bone matrix stays exactly put: the body slides on in the pose it last took, and the bone tree is not walked')
    }
  }
  // The tint row, which is how the ladder is confirmed by eye at all: halving
  // the triangles of a smooth mesh barely moves its silhouette, so a swap is
  // invisible without a colour on it. One flat colour a rung, and a fade shows
  // only the tier it is going TO, so what she reads is never a blend of two.
  {
    // The slot was let go out past the card and taken again coming back, so the
    // animal in it is whichever stag she is standing over now -- and the rungs
    // are read off ITS body, not the one that walked away.
    const top0 = reach(0) / 2
    const last = reach(LOD_RUNGS - 1) * 0.9
    // Settled first: it is mid-dissolve from the walk back in above, and a fading puppet draws two meshes through the fade materials by design.
    settle(top0)
    const p = c.puppet
    const shown = () => p.meshes.filter((m) => m.visible)
    check(shown().length === 1 && shown()[0].material === p.mats.plain, 'with the tint off a settled puppet draws through its own species material')
    setTierTint(true)
    at(top0, 2, 1 / 60)
    const tint = shown()[0].material
    check(shown().length === 1 && tint.isMeshBasicMaterial === true && tint !== p.mats.plain, 'the tint repaints a puppet that was already standing still, with no tier change to prompt it')
    settle(last)
    const bottom = shown()[0].material
    check(p.meshes.indexOf(shown()[0]) === LOD_RUNGS - 1 && bottom.isMeshBasicMaterial === true && bottom !== tint, 'and the last rung wears a different colour from the first, which is the whole of what it is for')
    setTierTint(false)
    at(last, 2, 1 / 60)
    check(shown()[0].material === p.mats.plain, 'turning it off puts the species material back')
  }
}
// --- the ladder is an arc, and so a ratio of the body ------------------------------
//
// FOUR RUNGS, each twice as far off as the one above it, and every distance in
// it set by the ARC the body has shrunk to rather than by metres -- so one
// ladder serves a hare, a stag and whatever is built next, and a big animal
// holds its detail further out because that is what she sees.
{
  // The stag, because it is the body the ladder was tuned against: its first swap is meant to land on ten metres.
  const size = 2.23
  const rungs = Array.from({ length: LOD_RUNGS }, (_, k) => lodReach(size, k))
  check(LOD_RUNGS === 4 && rungs.map((d) => d.toFixed(0)).join(',') === '10,20,40,80', 'a stag steps down at 10, 20 and 40 metres and is culled past 80', rungs.map((d) => `${d.toFixed(1)}`).join(' / '))
  check(rungs.every((d, k) => k === 0 || Math.abs(d / rungs[k - 1] - LOD_STEP) < 1e-12), `each rung reaching exactly ${LOD_STEP} times as far as the one above it`)
  check(Math.abs(2 * Math.atan(size / (2 * rungs[0])) * (180 / Math.PI) - LOD_DEG) < 1e-9 && [0.5, 3, 7].every((m) => Math.abs(cullRange(size * m) - cullRange(size) * m) < 1e-9), `a body leaves tier 0 at ${LOD_DEG} degrees of arc whatever its size, so the whole ladder scales with the body`)
  check(cullRange(size) === rungs[LOD_RUNGS - 1] && critterTier(size, cullRange(size) + 1e-6, -1) === LOD_RUNGS, 'past the last rung there is no rung to be on -- that is the cull')
  check(Math.abs(forgetRange(size) / cullRange(size) - CULL_KEEP) < 1e-12, `and a placement is remembered to ${Math.round((CULL_KEEP - 1) * 100)}% past the cull`, `${cullRange(size).toFixed(0)} m drawn, ${forgetRange(size).toFixed(0)} m remembered`)

  // The edge is pushed away from whichever rung the body is already on, so a body sitting on one does not flicker between two.
  const e = rungs[0] * (1 + LOD_HYSTERESIS)
  check(critterTier(size, e - 1e-9, 0) === 0 && critterTier(size, e + 1e-9, 0) === 1, `a rung is held ${Math.round(LOD_HYSTERESIS * 100)}% past its reach before it is given up`, `${rungs[0].toFixed(1)} m held to ${e.toFixed(1)}`)
  const b = rungs[0] * (1 - LOD_HYSTERESIS)
  check(critterTier(size, b + 1e-9, 1) === 1 && critterTier(size, b - 1e-9, 1) === 0, `and won back ${Math.round(LOD_HYSTERESIS * 100)}% inside it`, `${rungs[0].toFixed(1)} m won back at ${b.toFixed(1)}`)
  check(critterTier(size, rungs[1] * 1.01, 0) === 2, 'a jump of two rungs lands on the rung the distance says, not one step down it')

  // Size is the body's LARGEST extent, and this layer says so rather than assuming its animals are longer than they are tall.
  check(w.species.every((sp) => Math.abs(sp.bulk - Math.max(sp.asset.span, sp.asset.width, sp.asset.height) / sp.asset.span) < 1e-12), 'the ladder is fed the largest extent of the body, whichever way round it is built', w.species.map((sp) => `${sp.key} x${sp.bulk.toFixed(2)}`).join(', '))
  check(scatter(w).every((s) => Math.abs(s.lodSize - s.size * s.sp.bulk) < 1e-12 && s.cull === cullRange(s.lodSize) && s.card === cullRange(s.lodSize, CARD_RUNGS) && s.forget === forgetRange(s.lodSize, CARD_RUNGS)), 'and every spawn carries its own mesh cull, card reach and forget, rolled with it')
  check(scatter(w).every((s) => Math.abs(s.card / s.cull - LOD_STEP) < 1e-12), `the card reaching exactly ${LOD_STEP} times as far as the last mesh rung, which is what makes it one more rung of the same ladder`)
  // THE PLACEMENT RADIUS IS SIZED OFF THE CARD, not off the mesh cull: a card
  // that reached past the tile horizon would be an animal appearing out of
  // nothing at the edge of the world, which is the pop the card exists to stop.
  const horizon = RADIUS + (TILE * Math.SQRT2) / 2
  const cards = scatter(w).map((s) => s.card)
  check(cullRange(CARD_BODY_M, CARD_RUNGS) <= horizon, `the world is placed far enough out to hold the card of a ${CARD_BODY_M} m body`, `${cullRange(CARD_BODY_M, CARD_RUNGS).toFixed(0)} m of card inside a ${horizon.toFixed(0)} m horizon`)
  check(Math.max(...cards) < horizon, 'so every animal in it fades in on its card, inside the world, rather than arriving with its tile', `furthest card ${Math.max(...cards).toFixed(0)} m, nearest ${Math.min(...cards).toFixed(0)}`)
}
// --- and a far animal thinks less often --------------------------------------------
//
// An animal's frame is its ground work: the look-ahead seat test, the height
// under its feet and the normal it stands on, each of them a walk over every
// stone and every piece of deadwood in the world. That is what a herd costs --
// the mixer beside it is three microseconds -- so it is bucketed by rung, and an
// animal on its card reads the ground a fifth as often as one at her feet.
{
  check(PROBE_EVERY.length === CARD_RUNGS && PROBE_EVERY.every((n, k) => k === 0 || n > PROBE_EVERY[k - 1]), 'there is one probe stride a rung, the card included, and every rung further off reads the ground strictly less often than the one above it', PROBE_EVERY.join(' / '))
  const dt = 1 / 60
  // The world's ground, with a note taken of every normal it is asked for and where.
  let asked = []
  const counted = { ...walk, normalAt: (x, z, eps, out) => { asked.push(`${x},${z}`); return walk.normalAt(x, z, eps, out) } }
  for (let rung = 0; rung <= LOD_RUNGS; rung++) {
    const k = make(7, { walk: counted, water, height })
    k.place(0, 0)
    const c = beside(k, 'stag')
    // Straight up over it, so it stays on the one rung and nothing else about the world moves.
    const d = lodReach(c.spawn.lodSize, rung) * 0.9
    for (let f = 0; f < 60; f++) step(k, c.x, c.y + d, c.z, dt)
    // Kept walking: a standing body reads no ground. The placement's own frame probes whatever the cadence says, so it is spent before the count.
    walkOn(k, c, c.sh, 'walk', 100000)
    step(k, c.x, c.y + d, c.z, dt)
    let probes = 0
    const frames = 600
    for (let f = 0; f < frames; f++) {
      asked = []
      step(k, c.x, c.y + d, c.z, dt)
      // The ground under the feet is read at the animal's own position; the seat test reads a body length ahead of it.
      if (asked.includes(`${c.x},${c.z}`)) probes++
    }
    check(c.lod === rung && Math.abs(probes - frames / PROBE_EVERY[rung]) <= 1, `on rung ${rung}${rung === LOD_RUNGS ? ', its card' : ''} a walking stag reads the ground once every ${PROBE_EVERY[rung]} frames`, `${probes} probes in ${frames} frames, wanted ${Math.round(frames / PROBE_EVERY[rung])}`)
    // Stood still, facing where it faces: one probe seats it where it stopped, and the probe frames after that read nothing.
    still(k, c, 'graze', 'eat-loop')
    for (let f = 0; f < PROBE_EVERY[rung] * CARD_EVERY; f++) step(k, c.x, c.y + d, c.z, dt)
    probes = 0
    for (let f = 0; f < frames; f++) {
      asked = []
      step(k, c.x, c.y + d, c.z, dt)
      if (asked.includes(`${c.x},${c.z}`)) probes++
    }
    check(c.speed === 0 && probes === 0, `and a stag standing there reads it on none of them`, `${probes} probes in ${frames} frames`)
    k.dispose()
  }
}

// --- past the last rung it is not thought about either -----------------------------
//
// The end of the ladder is one rule with two consequences: a creature she cannot
// see is not drawn AND NOT SIMULATED. Nothing walks, turns, probes the ground or
// picks an activity out there. Where it had got to is remembered while it might
// matter, and dropped when it cannot. The card moved that line twice as far out,
// so an animal on its card is still a live animal, walking -- just thinking a
// fifth as often as one at her feet.
{
  const k = calm(make(7))
  k.place(0, 0)
  const c = beside(k, 'hare')
  const spawn = c.spawn
  const dt = 1 / 60
  // Ten seconds of roaming with her walking beside it, to take it somewhere other than home.
  walkOn(k, c, c.sh, c.sp.gaits[0][0], 400)
  for (let f = 0; f < 600; f++) step(k, c.x, c.y + 1.6, c.z, dt)
  const at = { x: c.x, y: c.y, z: c.z, heading: c.heading, tick: c.rec.tick, clip: c.clip }
  check(Math.hypot(c.x - c.home.x, c.z - c.home.z) > 1, 'a hare she has watched for ten seconds is no longer standing at home', `${Math.hypot(c.x - c.home.x, c.z - c.home.z).toFixed(2)} m off it`)

  // Out past the meshes but inside the card: a live hare still, and still walking.
  const onCard = { x: at.x + spawn.cull * 1.3, y: at.y + 1.6, z: at.z }
  for (let f = 0; f < 120; f++) step(k, onCard.x, onCard.y, onCard.z, dt)
  const sp = k.species.find((s) => s.key === 'hare')
  check(c.spawn === spawn && c.lod === LOD_RUNGS && !c.puppet && c.cardWant && c.cardP === 1 && sp.cardN > 0, `${(spawn.cull * 1.3).toFixed(0)} m off, past the last mesh rung, the hare has given its puppet back and is a card`)
  check(Math.hypot(c.x - at.x, c.z - at.z) > 0.1 || c.act !== 'roam', 'and it is a card that is still living its life out there, not a photograph parked where it was last seen', `${Math.hypot(c.x - at.x, c.z - at.z).toFixed(2)} m on, doing ${c.act}`)

  // Out past the card too, but not past where the placement is worth keeping.
  const eye = { x: c.x + (spawn.card + spawn.forget) / 2, y: c.y + 1.6, z: c.z }
  for (let f = 0; f < 240; f++) step(k, eye.x, eye.y, eye.z, dt)
  Object.assign(at, { x: c.x, y: c.y, z: c.z, heading: c.heading, tick: c.rec.tick, clip: c.clip })
  for (let f = 0; f < 240; f++) step(k, eye.x, eye.y, eye.z, dt)
  check(c.spawn === spawn && c.lod === CARD_RUNGS && !c.puppet && !c.cardWant && c.cardP === 1, `${spawn.card.toFixed(0)} m off, past the card as well, the hare is not drawn at all but the slot is still hers`)
  check(c.x === at.x && c.z === at.z && c.y === at.y && c.heading === at.heading && c.rec.tick === at.tick && c.clip === at.clip, 'and in four seconds of it nothing walked, turned, read the ground or picked an activity -- it stands exactly where it stood')
  // Back in sight, the ticks it was not stepped through are replayed in the one frame, so it is where the score has it now: it lived while she was away, it just was not looked at.
  const r0 = k.replayed
  step(k, at.x, at.y + 1.6, at.z, 0)
  const owed = tickOf(timeOf(k)) - at.tick
  check(c.spawn === spawn && owed > 100 && c.rec.tick === at.tick + owed && k.replayed - r0 >= owed, 'she comes back and it is where the score has it, the ticks she was away for replayed in that frame', `${owed} ticks, ${k.replayed - r0} replayed across the herd`)

  // And out past where it is worth keeping.
  for (let f = 0; f < 240; f++) step(k, at.x + spawn.forget * 1.2, at.y + 1.6, at.z, dt)
  check(spawn.slot === null && c.spawn === null && k.species.find((sp) => sp.key === 'hare').free.includes(c), `${Math.round((CULL_KEEP - 1) * 100)}% past the card's reach the slot goes back in the pool`, `${spawn.forget.toFixed(0)} m`)
  check(scatter(k).includes(spawn), 'but the tile still holds the spawn -- where it stands when nothing has moved it is not a thing that can be forgotten')
  // The next waking is not a reset to home: it stands the hare where the score has it, which is where any other client waking it at that moment stands it.
  step(k, spawn.x, spawn.y + 1.6, spawn.z, 0)
  const again = k.species.find((sp) => sp.key === 'hare').slots.find((s) => s.spawn === spawn)
  const twin = calm(make(7))
  jump(twin, timeOf(k))
  step(twin, spawn.x, spawn.y + 1.6, spawn.z, 0)
  const other = twin.byKey.get(spawn.key)
  const alike = (a, b) => a.sx === b.sx && a.sz === b.sz && a.sh === b.sh && a.act === b.act && a.clip === b.clip && a.rec.tick === b.rec.tick
  check(again && other && again !== other && again.key === spawn.key && alike(again, other), 'and the next waking stands it where the score has it, as a second client waking it then would', again && other ? `${again.act} on ${again.clip}, tick ${again.rec.tick}` : 'no slot')
  twin.dispose()
  k.dispose()
}

// --- nothing pops ----------------------------------------------------------------
//
// Every tier change, appearance and vanishing is a dissolve, and it is TIMED
// and not banded: a teleport crosses a whole distance band in one frame, so a
// fade driven by the band edge would still pop and this one must not.
{
  w.place(0, 0)
  wake(w)
  const c = alive(w).find((a) => a.sp.key === 'stag')
  const run = (d, frames = 1, dt = 1 / 60) => { for (let f = 0; f < frames; f++) step(w, c.x, c.y + d, c.z, dt) }
  const vis = () => (c.puppet ? c.puppet.meshes.map((m, k) => (m.visible ? k : -1)).filter((k) => k >= 0) : [])
  const close = lodReach(c.spawn.lodSize, 0) / 2
  const out = lodReach(c.spawn.lodSize, LOD_RUNGS - 1) * 0.9
  const gone = lodReach(c.spawn.lodSize, CARD_RUNGS - 1) * 4

  run(close, 40)
  const p = c.puppet
  check(p && vis().join() === '0' && p.meshes[0].material === p.mats.plain && p.mats.uCut.value === 1, 'settled on a rung, an animal draws that one tier and draws it through the plain material')

  run(out, 1)
  const both = vis()
  check(both.length === 2 && both[0] === 0 && both[1] === LOD_RUNGS - 1 && p.meshes[both[0]].material === p.mats.out && p.meshes[both[1]].material === p.mats.in && p.mats.uCut.value > 0 && p.mats.uCut.value < 1,
    'a step down the ladder draws both rungs at once, the old one masked out and the new one in', `tiers ${both.join(' and ')}, cut ${p.mats.uCut.value.toFixed(2)}`)
  run(out, Math.ceil(LOD_FADE_S * 60) + 2)
  check(vis().join() === String(LOD_RUNGS - 1) && p.meshes[LOD_RUNGS - 1].material === p.mats.plain && p.mats.uCut.value === 1, 'and once it is over only the new rung is left, back on the plain material')

  // Straight off the last rung to nothing, skipping the card entirely: the far side of the same one fade.
  run(gone, 1)
  check(c.lod === CARD_RUNGS && c.puppet === p && vis().length === 1 && p.meshes[vis()[0]].material === p.mats.out && p.mats.uCut.value < 1,
    'past the last rung an animal is not switched off but dissolved, and holds its puppet -- walking, turning, animating -- while it goes')
  let frames = 1
  while (c.puppet && frames < 120) { run(gone, 1); frames++ }
  check(!c.puppet && Math.abs(frames / 60 - LOD_FADE_S) < 3 / 60, `a vanishing takes LOD_FADE_S however far the step was -- a teleport dissolves too`, `${(frames / 60).toFixed(3)} s for a ${(gone - out).toFixed(0)} m jump`)
  check(w.species.every((sp) => sp.freePuppets.length === PUPPETS), 'and every puppet is back in its pool once nothing is in sight')
}
// AND THE CARD DITHERS WITH THE MESH, not after it. The mesh's cut and the
// card's coverage are the same number against the same screen-space hash, so
// what she loses off one she gains on the other: the pixels are partitioned
// through the whole swap and never doubled or dropped.
{
  w.place(0, 0)
  wake(w)
  const c = alive(w).find((a) => a.sp.key === 'stag')
  const sp = w.species.find((s) => s.key === 'stag')
  const run = (d, frames = 1, dt = 1 / 60) => { for (let f = 0; f < frames; f++) step(w, c.x, c.y + d, c.z, dt) }
  // Which instance of the card mesh is this animal's, by where it stands.
  const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3()
  // The attribute is a Float32Array, so nothing read back out of it compares exact against a double.
  const near = (a, b) => a !== null && Math.abs(a - b) < 1e-6
  const cardOf = () => {
    for (let i = 0; i < sp.cardN; i++) {
      sp.cardMesh.getMatrixAt(i, _m)
      _m.decompose(_p, _q, _s)
      // The instance matrix is a Float32Array, so a world coordinate in the hundreds comes back rounded.
      if (_p.distanceTo(new THREE.Vector3(c.x, c.y, c.z)) < 1e-3) return sp.cardFade.array[i]
    }
    return null
  }
  const last = lodReach(c.spawn.lodSize, LOD_RUNGS - 1) * 0.9
  const onCard = lodReach(c.spawn.lodSize, LOD_RUNGS) * 0.9
  run(last, Math.ceil(LOD_FADE_S * 60) + 4)
  const p = c.puppet
  check(p && cardOf() === null && p.mats.uCut.value === 1, 'settled on the last mesh rung, an animal has no card drawn for it at all')

  run(onCard, 1)
  const half = cardOf()
  check(c.lod === LOD_RUNGS && c.puppet === p && p.meshes.filter((m) => m.visible).length === 1 && p.meshes[LOD_RUNGS - 1].material === p.mats.out && p.mats.uCut.value < 1,
    'stepping out onto the card, the mesh is not switched off but dissolved out, holding its puppet while it goes')
  check(half > 0 && near(half, p.mats.uCut.value), 'and the card is dithered in against that very same cut, so the two masks partition the pixels rather than overlap', `card ${half?.toFixed(3)} against cut ${p.mats.uCut.value.toFixed(3)}`)
  run(onCard, Math.ceil(LOD_FADE_S * 60) + 4)
  check(!c.puppet && cardOf() === 1, 'and once it is over the puppet is back in the pool and the card is whole', `${sp.cardN} cards drawn`)

  // Back in again: the card dissolves out under a mesh dissolving in. The card's
  // coverage and the mesh's cut now sum to one, which is the same partition read
  // from the other end -- the card keeps the hash's high side, the mesh the low.
  run(last, 1)
  check(c.lod === LOD_RUNGS - 1 && c.puppet && c.puppet.mats.uCut.value < 1 && near(cardOf(), -(1 - c.puppet.mats.uCut.value)),
    'and coming back the other way the card dissolves out under the mesh dissolving in, off the same cut again', `card ${cardOf()?.toFixed(3)} against cut ${c.puppet.mats.uCut.value.toFixed(3)}`)
  run(last, Math.ceil(LOD_FADE_S * 60) + 4)
  check(c.puppet && c.puppet.mats.uCut.value === 1 && cardOf() === null, 'until the card is gone and only the animal is left', `${sp.cardN} cards still drawn, for the stags further out`)

  // A REVERSAL MID-FADE REWINDS THE ONE RUNNING rather than starting a second: she turns back after four frames, and the card has four frames' worth left to take out, not a whole one.
  run(onCard, 4)
  const there = cardOf()
  run(last, 1)
  const back = cardOf()
  check(there > 0 && back < 0 && near(back, -(1 - c.puppet.mats.uCut.value)) && near(-back, there - 1 / 60 / LOD_FADE_S),
    'a card caught part way in and sent back out rewinds the fade it is already running rather than starting a second, and the mesh rewinds in step with it', `${there.toFixed(3)} in, ${(-back).toFixed(3)} left to take out`)
}

// A TILE UNLOAD IS THE OTHER WAY AN ANIMAL GOES, and for everything but a hare
// it is the usual one: the last rung reaches past where a tile can still be
// loaded, so a stag walked out of range is a stag whose tile unloaded. The
// puppet has to outlive the animal or that is a pop.
{
  w.place(0, 0)
  wake(w)
  const c = alive(w).find((a) => a.sp.key === 'stag')
  for (let f = 0; f < 40; f++) step(w, c.x, c.y + 20, c.z, 1 / 60)
  const p = c.puppet
  check(p && p.meshes.filter((m) => m.visible).length === 1, 'a stag close by is drawn')

  // Her head 400 m away: every tile unloads, so the animal is gone from the world entirely.
  step(w, c.x + 400, c.y, c.z + 400, 1 / 60)
  check(c.spawn === null && !c.puppet, 'walk far enough and its tile unloads, taking the animal with it')
  check(w.fading.some((f) => f.puppet === p), 'but its body stays behind, dissolving where it stood', `${w.fading.length} bodies fading`)
  const vis = p.meshes.filter((m) => m.visible)
  check(vis.length === 1 && vis[0].material === p.mats.out && p.mats.uCut.value < 1 && p.group.parent, 'drawn through the dissolving-out material, still in the batch, on its way out rather than switched off')
  const stags = w.fading.filter((f) => f.sp.key === 'stag').length
  check(stags > 0 && w.species.find((sp) => sp.key === 'stag').freePuppets.length === PUPPETS - stags, 'and is nobody else\'s puppet until it has gone')

  let frames = 1
  while (w.fading.length && frames < 120) { step(w, c.x + 400, c.y, c.z + 400, 1 / 60); frames++ }
  check(!w.fading.length && Math.abs(frames / 60 - LOD_FADE_S) < 3 / 60, 'the fade takes LOD_FADE_S like any other', `${(frames / 60).toFixed(3)} s`)
  check(!p.group.parent && w.species.every((sp) => sp.freePuppets.length === PUPPETS), 'and then it leaves the batch and goes back to the pool')

  // The terrain rebuild is the one case that does not fade: the ground the body was standing on is not there any more.
  for (let f = 0; f < 40; f++) step(w, 0, 20, 0, 1 / 60)
  const drawn = alive(w).filter((a) => a.puppet)
  check(drawn.length > 0, 'animals are drawn again around her')
  w.place(0, 0)
  check(!w.fading.length && w.species.every((sp) => sp.freePuppets.length === PUPPETS) && drawn.every((a) => !a.puppet), 'a place() takes every puppet back at once, fading ones included -- the ground they stood on has moved')
}
// --- the dragon's verbs: roster, spawnAt, poseAt, kill, carry, drop ----------------
//
// A killed stag is a slot with no spawn, off every tile and every list, drawn
// only where its carrier puts it: hanging by the back from the talons, or
// rolled onto its flank on the nest floor. Its spawn sleeps to its chapter's turn.
{
  const k = make(7)
  k.place(0, 0)
  const dt = 1 / 60
  const c = beside(k, 'stag')
  const t0 = timeOf(k)
  const stags = scatter(k).filter((s) => s.sp.key === 'stag')
  const resident = k.tiles.size
  const near = k.roster(c.spawn.x, c.spawn.z, 60)
  const expect = stags.filter((s) => Math.hypot(s.x - c.spawn.x, s.z - c.spawn.z) <= 60).map((s) => s.key).sort()
  check(near.length >= 2 && near.map((r) => r.key).join() === expect.join() && near.every((r) => { const s = stags.find((o) => o.key === r.key); return r.x === s.x && r.z === s.z }), 'roster() lists every stag spawn within range, in key order, each at its spawn point', `${near.length} of ${stags.length} resident stags within 60 m`)
  const one = k.roster(c.spawn.x, c.spawn.z, 0.01)
  check(one.length === 1 && one[0].key === c.key, 'asked from on top of one, that one alone')
  const wide = k.roster(RADIUS + 300, 0, 100)
  check(wide.length > 0 && wide.every((r) => r.key.startsWith('st:') && !stags.some((s) => s.key === r.key)) && k.tiles.size === resident && k.rolled.size > 0, 'asked past the resident tiles it rolls those without making them resident, from a bounded cache, and lists only stags', `${wide.length} stags over ${k.rolled.size} rolled tiles`)
  const far = wide[0]
  check(k.spawnAt(c.key).x === c.spawn.x && k.spawnAt(c.key).z === c.spawn.z && k.spawnAt(far.key).x === far.x, 'spawnAt() is the spawn point, resident or rolled')
  let threw = ''
  try { k.spawnAt('st:0,0:99') } catch (e) { threw = e.message }
  check(threw.includes('no animal keyed'), 'and a key no tile rolled throws', threw)

  // poseAt: the free plan, closed form, is where the stepped body is.
  for (let f = 0; f < 90; f++) step(k, c.spawn.x, c.spawn.y + 1.6, c.spawn.z, dt)
  const at = k.poseAt(c.key, timeOf(k))
  check(Math.abs(at.x - c.sx) < 1e-9 && Math.abs(at.z - c.sz) < 1e-9 && Math.abs(at.heading - c.sh) < 1e-9 && at.y === height.heightAt(at.x, at.z), 'poseAt() at the clock is the tick pose the stepped body holds, on the height field', `${Math.hypot(at.x - c.sx, at.z - c.sz).toExponential(1)} m off`)
  const farPose = k.poseAt(far.key, 12345.6)
  check(Math.hypot(farPose.x - far.x, farPose.z - far.z) <= TETHER_M + 1e-6 && k.tiles.size === resident && !alive(k).some((a) => a.key === far.key), 'a stag on no resident tile has a pose too, inside its tether, without waking or a tile', `${Math.hypot(farPose.x - far.x, farPose.z - far.z).toFixed(1)} m from home`)

  // kill: the live slot where the stag is awake.
  threw = ''
  try { k.kill('st:0,0:99', timeOf(k)) } catch (e) { threw = e.message }
  check(threw.includes('no animal keyed'), 'killing a key no tile rolled throws', threw)
  const spawn = c.spawn
  const { height: bodyH, width } = c.sp.asset
  const before = k.bodies([]).length
  const tk = timeOf(k)
  const got = k.kill(c.key, tk)
  check(got === c && c.spawn === null && spawn.slot === null && c.act === 'dead', 'kill() hands back the live slot, off its spawn, and the spawn has no slot')
  check(spawn.deadUntil === chapterOf(tk, c.key, CHAPTER_S).start + CHAPTER_S && !k.score.cache.has(c.key), 'struck off its plan, the spawn sleeps to its chapter\'s end and its plan is forgotten', `${(spawn.deadUntil - tk).toFixed(1)} s`)
  check(c.clip === 'dead' && c.dur === c.sp.durations.dead && Number.isNaN(c.stepStart) && c.queue.length === 0 && c.speed === 0, 'the slot is on the dead clip from its start, held its whole length, nothing queued behind it', `${c.dur.toFixed(2)} s`)
  check(!k.bodies([]).includes(c) && k.bodies([]).length === before - 1, 'and it is off the list the ear reads')
  check(!k.species[0].free.includes(c), 'but not back in the pool: it is cargo now')
  for (let f = 0; f < 120; f++) step(k, spawn.x, spawn.y + 1.6, spawn.z, dt)
  check(spawn.slot === null && !alive(k).some((a) => a.spawn === spawn) && k.roster(spawn.x, spawn.z, 0.01).length === 1, 'two seconds of her standing on the dead spawn wake no second stag there, though the roster still names it -- the dragons plan over spawns, not bodies')
  jump(k, spawn.deadUntil + 0.05)
  step(k, spawn.x, spawn.y + 1.6, spawn.z, 0)
  check(spawn.slot !== null && spawn.slot !== c && k.score.at(spawn.key, timeOf(k)).phrases[0].from === spawn.home, 'its chapter turned, a stag wakes there again on a new slot, planned from home')
  k._sleep(spawn)

  // kill: a stag asleep past its cull is dressed from its spawn.
  const asleep = stags.find((s) => s.slot === null && s !== spawn && s.deadUntil <= timeOf(k))
  const t4 = timeOf(k)
  const c4 = k.kill(asleep.key, t4)
  check(c4 !== null && c4.spawn === null && c4.key === asleep.key && c4.act === 'dead' && c4.clip === 'dead' && c4.k === asleep.size / asleep.sp.asset.span && c4.lodSize === asleep.lodSize, 'a stag asleep on its spawn is killed too: a pool slot dressed from the spawn, limp')
  check(asleep.deadUntil === chapterOf(t4, asleep.key, CHAPTER_S).start + CHAPTER_S && !k.species[0].free.includes(c4) && !k.bodies([]).includes(c4), 'its spawn asleep to the chapter\'s end, the slot cargo and off the ear\'s list')
  k.drop(c4, false)
  check(k.species[0].free.includes(c4), 'dropped, the slot is back in the pool')

  // Hanging: a yawed, scaled carrier matrix, the body's own frame under it.
  const M = new THREE.Matrix4().compose(new THREE.Vector3(12, 30, -7), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.8), new THREE.Vector3(c.k, c.k, c.k))
  k.carry(c, M, 10, dt)
  const p = c.puppet
  check(p !== null && c.lod < LOD_RUNGS && c.x === 12 && c.y === 30 && c.z === -7 && p.to === c.lod, 'carried ten metres off, the kill takes a puppet on a mesh rung and the slot sits at the matrix', p && `tier ${p.to}`)
  const gripLocal = new THREE.Vector3(0, GRIP * bodyH, 0).applyMatrix4(p.group.matrix)
  check(gripLocal.distanceTo(new THREE.Vector3(12, 30, -7)) < 1e-9, `hanging, the point ${GRIP} of its height up its body -- the back the talons hold -- is exactly at the matrix, and the rest sags below`, `grip lands ${gripLocal.distanceTo(new THREE.Vector3(12, 30, -7)).toExponential(1)} m off`)
  const upHung = new THREE.Vector3(0, 1, 0).transformDirection(p.group.matrix)
  check(Math.abs(upHung.y - 1) < 1e-9, 'its up is the world up: it hangs, it does not roll')
  check(p.actions.get('dead').isRunning() && p.ik !== null && p.ik.wTo === 0 && p.group.matrix.elements[0] !== 1, 'the puppet plays the dead clip with its feet unplanted -- there is no ground to plant on -- and wears the matrix\'s yaw and scale', `weight to ${p.ik?.wTo}`)
  const feetFrames = Math.ceil(c.dur * 60) + 5
  for (let f = 0; f < feetFrames; f++) k.carry(c, M, 10, dt)
  const a = p.actions.get('dead')
  check(a.paused && a.time >= c.dur - 1e-6, 'past its length the slump holds its last frame', `time ${a.time.toFixed(3)} of ${c.dur.toFixed(3)}`)

  // Lain: the same matrix on the nest floor, the body on its flank.
  k.carry(c, M, 10, dt, true)
  const upLain = new THREE.Vector3(0, 1, 0).transformDirection(p.group.matrix)
  check(Math.abs(upLain.y) < 1e-9, 'lain, the body\'s up is horizontal: it is on its side', `up.y ${upLain.y.toExponential(1)}`)
  const flank = [new THREE.Vector3(0.3, 0.5 * bodyH, LAIN * width), new THREE.Vector3(-0.3, 0.1 * bodyH, LAIN * width)].map((v) => v.applyMatrix4(p.group.matrix))
  check(flank.every((f) => Math.abs(f.y - 30) < 1e-9), `and the flank ${LAIN} of its width out is on the matrix's floor along the whole body`, flank.map((f) => (f.y - 30).toExponential(1)).join(' '))
  const spine = new THREE.Vector3(0, 0.5 * bodyH, 0).applyMatrix4(p.group.matrix)
  check(spine.y > 30 + 1e-6 && Math.abs(spine.y - 30 - LAIN * width * c.k) < 1e-9, 'so the spine is above the floor by that much of the width, at the body\'s scale', `${(spine.y - 30).toFixed(3)} m`)
  const fwd = new THREE.Vector3(1, 0, 0).transformDirection(p.group.matrix)
  check(Math.abs(fwd.y) < 1e-9 && Math.abs(Math.atan2(-fwd.z, fwd.x) - 0.8) < 1e-9, 'and it lies along the matrix\'s heading', `${Math.atan2(-fwd.z, fwd.x).toFixed(3)} rad`)

  // Far: past the mesh rungs the puppet dissolves and goes back to the pool, the slot stays cargo -- and its CARD takes over, under the talons, held as far as the carrier is drawn, which is past the stag's own card reach.
  const sp = k.species[0]
  const cards = () => sp.cardN
  // Each carry is a frame after an update() that has emptied and refilled the card buffer; here the refill is nothing.
  const carry = (...args) => { sp.cardN = 0; sp.cardMesh.count = 0; k.carry(c, ...args) }
  const uploads = sp.cardMesh.instanceMatrix.version
  carry(M, 1e4, dt)
  check(c.lod === LOD_RUNGS && p.to === -1, 'carried out past the last mesh rung, its puppet is sent out', `lod ${c.lod}`)
  check(c.cardWant && c.cardP < 1 && cards() === 1 && sp.cardMesh.count === 1 && sp.cardMesh.instanceMatrix.version === uploads + 1 && Math.abs(sp.cardFade.array[0] - c.cardP) < 1e-6, 'and its card comes in on the same dissolve, appended to the species\' buffer with the count and the upload flags set, since update() has already run this frame', `fade ${sp.cardFade.array[0].toFixed(3)}`)
  const cm = new THREE.Matrix4()
  sp.cardMesh.getMatrixAt(cards() - 1, cm)
  const cardGrip = new THREE.Vector3(0, GRIP * bodyH, 0).applyMatrix4(cm)
  const cardUp = new THREE.Vector3(0, 1, 0).transformDirection(cm)
  const cardScl = new THREE.Vector3().setFromMatrixScale(cm)
  check(cardGrip.distanceTo(new THREE.Vector3(12, 30, -7)) < 1e-5 && Math.abs(cardUp.y - 1) < 1e-9 && Math.abs(cardScl.x - c.k) < 1e-6, `the card stands upright at the body's size with the point ${GRIP} of its height up at the matrix, exactly where the mesh hung`, `grip ${cardGrip.distanceTo(new THREE.Vector3(12, 30, -7)).toExponential(1)} m off`)
  for (let f = 0; f < Math.ceil(LOD_FADE_S * 60) + 2; f++) carry(M, 1e4, dt)
  check(c.puppet === null && sp.freePuppets.includes(p) && c.act === 'dead' && c.spawn === null, 'and once it has dissolved the puppet is back in the pool while the slot is still the dragon\'s')
  check(c.cardP === 1 && c.cardWant && cards() === 1 && sp.cardFade.array[0] === 1 && 1e4 > cullRange(c.lodSize, CARD_RUNGS), `while the card is settled and whole, ${(1e4 / cullRange(c.lodSize, CARD_RUNGS)).toFixed(0)} times the stag's own card reach out: a kill in sight under a dragon is never dropped from the picture`)
  sp.cardMesh.getMatrixAt(0, cm)
  check(new THREE.Vector3(0, GRIP * bodyH, 0).applyMatrix4(cm).distanceTo(new THREE.Vector3(12, 30, -7)) < 1e-5, 'still under the talons')
  carry(M, 1e4, dt, true)
  sp.cardMesh.getMatrixAt(0, cm)
  check(new THREE.Vector3().setFromMatrixPosition(cm).distanceTo(new THREE.Vector3(12, 30, -7)) < 1e-5 && Math.abs(new THREE.Vector3(0, 1, 0).transformDirection(cm).y - 1) < 1e-9, 'lain, the card stands upright on the matrix -- a spun quad has no flank to roll onto')
  // The carrier out of sight: the card goes with it, on the dissolve.
  carry(M, 1e4, dt, false, false)
  check(!c.cardWant && c.cardP < 1 && cards() === 1 && sp.cardFade.array[0] < 0, 'told its carrier is not drawn, the card is sent out through the dissolve rather than dropped', `fade ${sp.cardFade.array[0].toFixed(3)}`)
  for (let f = 0; f < Math.ceil(LOD_FADE_S * 60) + 2; f++) carry(M, 1e4, dt, false, false)
  check(!c.cardWant && c.cardP === 1 && cards() === 0 && sp.cardMesh.count === 0, 'and once out it is not in the buffer at all')
  carry(M, 1e4, dt, false, true)
  check(c.cardWant && c.cardP < 1 && cards() === 1, 'the carrier back in sight, the card comes back in')
  const hidden = k.batch.visible
  k.batch.visible = false
  k.carry(c, M, 1e4, dt)
  check(cards() === 1 && c.cardWant, 'a hidden layer, which update() is not stepping, has nothing appended to its buffer', `${cards()} cards`)
  k.batch.visible = hidden
  carry(M, 10, dt)
  check(c.puppet !== null && c.puppet.actions.get('dead').isRunning(), 'brought back within reach it takes a puppet again, on the dead clip')

  // Drop, fading: the puppet dissolves where it hangs; the slot goes home.
  const fadingBefore = k.fading.length
  const drop = c.puppet
  k.drop(c)
  check(c.puppet === null && k.fading.length === fadingBefore + 1 && k.fading[k.fading.length - 1].puppet === drop && drop.to === -1, 'drop() leaves the body dissolving where it was let go')
  check(k.species[0].free.includes(c) && c.act === 'stand' && c.lod === CARD_RUNGS && c.spawn === null && !c.cardWant && c.cardP === 1, 'and the slot is back in the pool, empty, its card state cleared')

  // Drop at card range: the card dissolves where it was let go, on the buffer for LOD_FADE_S, without the slot.
  {
    k.place(0, 0)
    const c3 = beside(k, 'stag')
    k.kill(c3.key, timeOf(k))
    for (let f = 0; f < Math.ceil(LOD_FADE_S * 60) + 2; f++) { sp.cardN = 0; k.carry(c3, M, 1e4, dt) }
    check(c3.cardWant && c3.cardP === 1 && !c3.puppet, 'a kill carried at card range is a settled card')
    k.drop(c3)
    check(k.fadingCards.length === 1 && k.fadingCards[0].sp === sp && k.fadingCards[0].p === 0 && !c3.cardWant && c3.cardP === 1, 'dropped there, its card is left dissolving where it hung, from the start of the ramp, and the slot\'s own card state is cleared')
    check(new THREE.Vector3(0, GRIP * bodyH, 0).applyMatrix4(k.fadingCards[0].mat).distanceTo(new THREE.Vector3(12, 30, -7)) < 1e-5, 'under the talons that let it go')
    let frames = 0
    let seen = 0
    while (k.fadingCards.length && frames < 100) {
      step(k, 1e5, 0, 1e5, dt)
      frames++
      if (sp.cardN === 1 && sp.cardFade.array[0] < 0 && sp.cardMesh.count === 1) seen++
    }
    check(Math.abs(frames / 60 - LOD_FADE_S) < 3 / 60 && seen === frames - 1 && sp.cardN === 0 && sp.cardMesh.count === 0, 'the card fades out over LOD_FADE_S on the high side of the hash, drawn every frame of it with the count set, and is gone from the buffer the frame the ramp ends', `${frames} frames, ${seen} drawn leaving`)
  }
  threw = ''
  try { k.carry(c, M, 10, dt) } catch (e) { threw = e.message }
  check(threw.includes('not seized'), 'carrying a dropped slot throws', threw)
  threw = ''
  try { k.drop(c) } catch (e) { threw = e.message }
  check(threw.includes('not seized'), 'and so does dropping it twice', threw)

  // Drop with no fade: the ground under it has gone, the puppet goes straight back.
  k.place(0, 0)
  const c2 = beside(k, 'stag')
  k.kill(c2.key, timeOf(k))
  k.carry(c2, M, 10, dt)
  const p2 = c2.puppet
  const fading2 = k.fading.length
  k.drop(c2, false)
  check(p2 !== null && c2.puppet === null && k.fading.length === fading2 && k.species[0].freePuppets.includes(p2) && k.species[0].free.includes(c2), 'drop(c, false) vanishes the body and returns the puppet at once')
  k.dispose()
}

// --- a dragon's strike is in the score --------------------------------------------
//
// The dragons ask the free plan where a stag will be and tell this layer, through
// `hunter`, when they take it; the stag's own plan is the free plan cut there, the
// body where the free plan had it the tick before, then `dead` to the chapter's
// end. Every client derives the same cut, and one arriving after the strike never
// wakes the stag at all.
{
  const walkReads = { n: 0 }
  const spy = { ...walk, heightAt: (...a) => { walkReads.n++; return walk.heightAt(...a) }, normalAt: (...a) => { walkReads.n++; return walk.normalAt(...a) } }
  const k = make(7, { walk: spy, water, height })
  k.place(0, 0)
  const s = scatter(k).find((o) => o.sp.key === 'stag')
  const ch = chapterOf(1000, s.key, CHAPTER_S)
  const T0 = ch.start + 10
  const strike = T0 + 200
  const asked = []
  k.hunter = (key, a, b) => { asked.push([key, a, b]); return key === s.key && a <= strike && strike < b ? strike : null }
  jump(k, T0)
  walkReads.n = 0
  const free = k.freeScore.at(s.key, T0)
  check(walkReads.n === 0 && free.phrases.length > 1, 'a plan is made from the height field and the water alone: not one read of the walker\'s ground, which the room does not share', `${walkReads.n} walk reads`)
  step(k, s.x, s.y + 1.6, s.z, 0)
  const c = s.slot
  check(c !== null && asked.length >= 1 && asked.every(([key, a, b]) => b - a === CHAPTER_S && (key !== s.key || a === ch.start)), 'waking a stag asks the hunter over the chapter it is planned for, start to start', `${asked.length} asked`)
  const ps = k.score.at(s.key, T0).phrases
  const last = ps[ps.length - 1]
  const total = ps.reduce((t, ph) => t + ph.dur, 0)
  check(last.kind === 'dead' && last.steps.length === 1 && last.steps[0][0] === 'dead' && Math.abs(last.dur - (ch.start + CHAPTER_S - strike)) < 1e-9 && Math.abs(total - CHAPTER_S) < 1e-9, 'the chapter is cut at the strike: a dead phrase from there to its end, the whole still a chapter long', `dead ${last.dur.toFixed(1)} s of ${total.toFixed(1)}`)
  const cutAt = ps.slice(0, -1).reduce((t, ph) => t + ph.dur, 0)
  const wasFree = k.freeScore.at(s.key, strike).phrase
  const cutPh = ps[ps.length - 2]
  check(Math.abs(ch.start + cutAt - strike) < 1e-9 && cutPh.kind === wasFree.kind && cutPh.dur < wasFree.dur && cutPh.steps.reduce((t, st) => t + st[1], 0) <= cutPh.dur + 1e-9, 'the phrase the strike falls in ends there, its steps trimmed to fit', `${cutPh.kind} ${cutPh.dur.toFixed(2)} of ${wasFree.dur.toFixed(2)} s`)
  const before = k.poseAt(s.key, strike - TICK_S)
  check(last.from === last.to && Math.abs(last.from.x - before.x) < 1e-9 && Math.abs(last.from.z - before.z) < 1e-9 && Math.abs(last.from.heading - before.heading) < 1e-9 && cutPh.to === last.from, 'and it dies where the free plan had it the tick before, standing still from there', `${Math.hypot(last.from.x - before.x, last.from.z - before.z).toExponential(1)} m off`)
  check(ps.slice(0, -2).every((ph, i) => ph.kind === free.phrases[i].kind && ph.dur === free.phrases[i].dur && ph.to.x === free.phrases[i].to.x && ph.to.z === free.phrases[i].to.z), 'the phrases before it are the free plan\'s own')

  // Two clients, one cut.
  const k2 = make(7)
  k2.place(0, 0)
  k2.hunter = k.hunter
  jump(k2, T0 + 37.3)
  const ps2 = k2.score.at(s.key, T0 + 37.3).phrases
  check(ps2.length === ps.length && ps2.every((ph, i) => ph.kind === ps[i].kind && ph.dur === ps[i].dur && ph.to.x === ps[i].to.x && ph.to.z === ps[i].to.z), 'a second client asked at another moment derives the same cut chapter')

  // Walked into the strike, the woken stag is the dragon's: it sleeps until the chapter turns.
  const free0 = k.species[0].free.length
  jump(k, strike + 0.5)
  step(k, s.x, s.y + 1.6, s.z, 0)
  check(s.slot === null && k.species[0].free.length === free0 + 1 && k.species[0].free.includes(c) && s.deadUntil === ch.start + CHAPTER_S, 'stepped past the strike, the stag sleeps with its slot pooled, dead until its chapter turns', `${(s.deadUntil - strike).toFixed(1)} s`)
  step(k, s.x, s.y + 1.6, s.z, 1)
  check(s.slot === null, 'and a frame on it wakes nothing')
  jump(k, ch.start + CHAPTER_S + 0.05)
  step(k, s.x, s.y + 1.6, s.z, 0)
  check(s.slot !== null && k.score.at(s.key, timeOf(k)).phrases[0].from === s.home && k.score.at(s.key, timeOf(k)).phrases.every((ph) => ph.kind !== 'dead'), 'its chapter turned, it wakes at home on a chapter with no strike in it')

  // A joiner arriving after the strike.
  const k3 = make(7)
  k3.place(0, 0)
  k3.hunter = k.hunter
  const s3 = scatter(k3).find((o) => o.key === s.key)
  jump(k3, strike + 90)
  step(k3, s3.x, s3.y + 1.6, s3.z, 0)
  check(s3.slot === null && s3.deadUntil === ch.start + CHAPTER_S && !k3.score.cache.has(s.key), 'a client joining after the strike never wakes the stag: its spawn is measured once, found dead, and its plan is not kept')
  step(k3, s3.x, s3.y + 1.6, s3.z, 1)
  check(s3.slot === null && alive(k3).length > 0, 'and it stays asleep while the others wake around her', `${alive(k3).length} awake`)
  const t3 = timeOf(k3)
  const cargo = k3.kill(s.key, t3)
  check(cargo !== null && cargo.act === 'dead' && cargo.spawn === null && s3.deadUntil === ch.start + CHAPTER_S, 'killed there by the dragon that struck it, a carcass is dressed from the spawn and the spawn sleeps to the same turn')
  k3.drop(cargo, false)

  // A strike outside the chapter it is asked for is a bug in the dragons, said so.
  const k4 = make(7)
  k4.place(0, 0)
  k4.hunter = () => ch.start - 1
  let threw = ''
  try { k4.score.at(s.key, T0) } catch (e) { threw = e.message }
  check(threw.includes('outside its chapter'), 'a hunter naming a strike outside the chapter throws', threw)
  k.dispose(); k2.dispose(); k3.dispose(); k4.dispose()
}

// --- the ear hears the herd ------------------------------------------------------
//
// bodies() is what the ambience reads every frame for the footfall clock and
// the fox's call: the slots themselves, so a body keeps its identity from frame
// to frame, `speed > 0` on the ones on a gait. A frozen one is not listed, nor
// is anything on a hidden layer.
{
  const k = calm(make(7))
  k.place(0, 0)
  const c = beside(k, 'stag')
  const dt = 1 / 60
  walkOn(k, c, c.sh)
  step(k, c.x, c.y + 1.6, c.z, dt)
  const listed = k.bodies([])
  check(c.speed > 0 && listed.includes(c) && listed.every((a) => a.spawn !== null && a.lod < CARD_RUNGS && a.sp.key), 'a roaming stag is listed among the live animals, each with its species and nothing frozen', `${listed.length} listed, ${listed.filter((a) => a.speed > 0).length} moving`)
  check(c.cycle === c.sp.durations[c.clip] && c.cycle > 0 && ['walk', 'trot', 'run'].includes(c.clip), 'and carries its gait clip and that clip\'s own length for the footfall clock', `${c.clip} ${c.cycle.toFixed(3)} s`)
  still(k, c, 'graze', 'eat-loop')
  step(k, c.x, c.y + 1.6, c.z, dt)
  check(c.speed === 0 && k.bodies([]).includes(c), 'a grazing one is listed standing, at speed 0')
  k.batch.visible = false
  check(k.bodies([]).length === 0, 'a hidden layer lists nobody')
  k.batch.visible = true
  const spawn = c.spawn
  walkOn(k, c, c.sh)
  for (let f = 0; f < 240; f++) step(k, c.x + (spawn.card + spawn.forget) / 2, c.y + 1.6, c.z, dt)
  check(c.spawn === spawn && c.lod === CARD_RUNGS && c.speed > 0 && !k.bodies([]).includes(c), 'past the last rung a stag still on its walk clip is frozen, and not listed')
  k.dispose()
}

console.log(failures ? `\n${failures} failing` : `\nall wildlife checks pass`)
process.exit(failures ? 1 : 0)
