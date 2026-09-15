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
// anything but its own animated puppet, one drawn past the last rung, or one
// that pops on, off or between rungs instead of dissolving; a herd that does
// not settle after dark; a frame that costs more than a scatter is allowed to.
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
  Wildlife, SPECIES, CLIPS, ONE_SHOT, TILE, RADIUS, DENSITY, MAX, NIGHT_REST, PUPPETS, MAX_SLOPE, SNOW_MARGIN, TETHER_M, TURN_RATE,
} from '../src/v2/render/wildlife.js'
import { CRITTER_GLB, CULL_KEEP, LOD_HYSTERESIS, LOD_NEAR, LOD_RUNGS, critterTier, cullRange, forgetRange, lodReach } from '../src/v2/render/critters.js'
import { LOD_FADE_S } from '../src/v2/render/puppet.js'
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
  return { root, skeleton, tiers, clips, map: null, gait: quad.gait, sizeM: quad.sizeM, span: quad.span, width: quad.width, height: quad.height }
}
const assets = () => Object.fromEntries(SPECIES.map((sp) => [sp.key, makeAsset(sp.key)]))

// --- construction ---------------------------------------------------------------
const scene = new THREE.Scene()
const make = (seed, world = { walk, water, height }) =>
  new Wildlife(scene, world.height, world.water, { seed, walk: world.walk, assets: assets() })
const w = make(7)
check(w.loaded && w.species.length === 3 && w.species.map((s) => s.key).join(',') === 'stag,fox,hare', 'the three of them are loaded')
check(w.species.every((sp) => sp.puppets.length === PUPPETS && sp.freePuppets.length === PUPPETS && sp.slots.length === MAX && sp.free.length === MAX), `${PUPPETS} puppets and ${MAX} slots a species, all free`)
check(w.materials.length === 3 * PUPPETS * 3, 'three materials a puppet -- settled, dissolving in, dissolving out -- all offered to the lighting')
check(w.species.every((sp) => sp.materials.every((m) => m.plain.customProgramCacheKey() === `wildlife-${sp.key}` && m.in.customProgramCacheKey() === `wildlife-${sp.key}-fade` && m.out.customProgramCacheKey() === `wildlife-${sp.key}-fade`)) && new Set(w.materials.map((m) => m.customProgramCacheKey())).size === 6, 'two programs a species and not one a puppet: a settled one with no discard in it at all, and the dissolve both halves of a fade share')
check(w.batch.children.length === 0, 'nothing is in the batch but the puppets it lends out -- there is no card mesh to draw')
check(w.species.every((sp) => sp.puppets.every((p) => p.skeleton !== sp.asset.skeleton && p.skeleton.bones.length === 2 && p.meshes.length === LOD_RUNGS && p.meshes.every((m) => m.skeleton === p.skeleton && !m.visible) && !p.group.matrixAutoUpdate && p.actions.size === CLIPS.length)), 'each puppet has its own copy of the skeleton, every shared tier bound to it, none shown, and an action per clip')
check(w.species.every((sp) => sp.puppets.every((p) => [...p.actions].every(([name, a]) => (ONE_SHOT.has(name) ? a.loop === THREE.LoopOnce && a.clampWhenFinished : a.loop === THREE.LoopRepeat)))), `${[...ONE_SHOT].join(', ')} play once and hold, the rest cycle`)
{
  const compile = (m) => {
    const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <clipping_planes_fragment>\n#include <map_fragment>\n' }
    m.onBeforeCompile(shader)
    return shader
  }
  const mats = w.species[0].materials[0]
  const plain = compile(mats.plain)
  check(plain.uniforms.uHue === mats.uHue && plain.fragmentShader.includes('#define vHue uHue') && !plain.vertexShader.includes('aHue'), "a puppet's hue is its materials' one shared uHue uniform")
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
// Waking is the update's job, not place()'s, so a gate that wants animals runs a frame.
const wake = (of, hx = 0, hz = 0) => { of.update(hx, GROUND + 1.6, hz, 0); return of }
// A hare's cull is under thirty metres, so the only way to see one alive is to go and stand by it.
const beside = (of, key) => {
  const s = scatter(of).find((c) => c.sp.key === key)
  of.update(s.x, s.y + 1.6, s.z, 0)
  return of.species.find((sp) => sp.key === key).slots.find((c) => c.spawn === s)
}
const SEEDS = 40
{
  const counts = Object.fromEntries(SPECIES.map((sp) => [sp.key, 0]))
  let tiles = 0
  let overflow = 0
  for (let seed = 1; seed <= SEEDS; seed++) {
    const k = make(seed, { walk: plain, water: noWater, height })
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
  check(Object.values(rates).every((r) => Math.abs(r / DENSITY - 1) < 0.12), `one of EACH per ${Math.round(1 / DENSITY)} square metres, on open ground`, Object.entries(rates).map(([k2, r]) => `${k2} 1 per ${Math.round(1 / r)}`).join(', ') + ` over ${Math.round(area / 1e3)}k m2`)
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
    for (const c of scatter(k)) pool.push({ key: c.sp.key, x: c.x, y: c.y, z: c.z, size: c.size, hue: c.hue, nx: c.nx, ny: c.ny, nz: c.nz })
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
    const hues = new Set(mine.map((c) => c.hue.toFixed(4)))
    check(hues.size > mine.length / 2 && mine.every((c) => Math.abs(c.hue) <= sp.hue), `${sp.key}s wear their own hues within ${sp.hue}`, `${hues.size} hues in ${mine.length}`)
  }
  aside.dispose()
  // Determinism: the same seed lays the same animals twice.
  const key = (of) => scatter(of).map((c) => `${c.sp.key}:${c.x.toFixed(4)},${c.y.toFixed(4)},${c.z.toFixed(4)},${c.size.toFixed(4)}`).sort().join('|')
  const again = make(7)
  again.place(0, 0)
  check(key(again) === key(w) && scatter(w).length > 0, 'the scatter is a pure function of the seed', `${scatter(w).length} animals`)
  // And of position: the tiles she keeps hold the same animals when she steps.
  const kept = scatter(again).filter((c) => Math.hypot(c.x, c.z) < 30).map((c) => ({ c, x: c.x, z: c.z }))
  again.update(TILE, GROUND + 1.6, 0, 0)
  const held = new Set(scatter(again))
  check(kept.length > 0 && kept.every(({ c, x, z }) => held.has(c) && c.x === x && c.z === z), 'a step of one tile leaves the animals she keeps exactly where they were', `${kept.length} kept`)
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
wake(w)
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
  const swing = (a) => Math.atan2(Math.sin(a), Math.cos(a))
  const far = new Map() // the spawn -> where its animal stood when the minute began
  const got = new Map() // -> and where it has got to since
  let strayed = 0
  let ms = 0
  for (const a of alive(w)) if (Math.hypot(a.homeX, a.homeZ) > 60) far.set(a.spawn, [a.x, a.z])
  // Every heading of every animal, every frame: a tether turn, a turn away from
  // the water and a fresh roam all pass through here, and not one of them may
  // move a body faster than it can turn. A slot that went to sleep and was woken
  // again holds a different animal, which is a placement and not a turn.
  let snapped = 0
  let watched = 0
  let was = new Map()
  for (let f = 0; f < 3600; f++) {
    const t0 = performance.now()
    w.update(0, GROUND + 1.6, 0, dt)
    ms += performance.now() - t0
    const seen = new Map()
    for (const a of alive(w)) {
      const prev = was.get(a)
      if (prev && prev.spawn === a.spawn) { snapped = Math.max(snapped, Math.abs(swing(a.heading - prev.heading))); watched++ }
      seen.set(a, { spawn: a.spawn, heading: a.heading })
      if (far.has(a.spawn)) { strayed = Math.max(strayed, Math.hypot(a.x - a.homeX, a.z - a.homeZ)); got.set(a.spawn, [a.x, a.z]) }
    }
    was = seen
  }
  check(snapped <= TURN_RATE * dt + 1e-12, `in ${(watched / 1000).toFixed(0)}k animal-frames of wandering, no body ever turned faster than it may`, `worst ${(snapped / dt).toFixed(3)} rad/s of ${TURN_RATE}`)
  const wandered = [...far].filter(([sp, [x, z]]) => got.has(sp) && Math.hypot(got.get(sp)[0] - x, got.get(sp)[1] - z) > 1)
  check(far.size > 0 && wandered.length > far.size / 2, 'most of them have wandered somewhere in a minute', `${wandered.length} of ${far.size}`)
  // The probe looks a body length and a half ahead, so the animal itself may stand that much past the leash.
  const slack = 1.5 * Math.max(...[...far.keys()].map((sp) => sp.size)) + 0.5
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
  wake(k)
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
  const trace = (key, lift) => {
    const k = make(7)
    k.place(0, 0)
    const c = beside(k, key)
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
  const under = trace('stag', 1.6)
  const over = trace('stag', 60)
  const same = under.log.every((s, i) => s === over.log[i])
  check(same, 'fifteen seconds with her standing on top of it, and the stag does exactly what it would have done with her sixty metres up', `${under.log[under.log.length - 1].split('/').slice(0, 2).join('/')}`)
  const hare = trace('hare', 1.6)
  check(hare.away < 12, 'and the hare she is standing on has not bolted either', `${hare.away.toFixed(2)} m from her in 15 s`)
}

// --- drawn, or not drawn ---------------------------------------------------------
{
  w.place(0, 0)
  wake(w)
  const c = alive(w).find((a) => a.sp.key === 'stag')
  // Straight up over it, so the distance is exactly d and the tiles do not move; dt 0, so nothing walks out from under the test.
  const at = (d, frames = 2, dt = 0) => {
    for (let f = 0; f < frames; f++) w.update(c.x, c.y + d, c.z, dt)
    return c.lod
  }
  // Enough frames at a real dt for every dissolve to finish: a tier change, an appearance or a vanishing takes LOD_FADE_S, and a puppet is not back in the pool until it has.
  const settle = (d) => at(d, Math.ceil(LOD_FADE_S * 60) + 2, 1 / 60)
  // Every distance here is read off the animal's own body, because that is what the ladder is a ratio of. Held aside: past the cull the slot is let go and the spawn with it.
  const lodSize = c.spawn.lodSize
  const reach = (k) => lodReach(lodSize, k)
  const expect = (d) => critterTier(lodSize, d, -1, LOD_RUNGS)
  const close = reach(0) / 2
  const near = settle(close)
  check(near === 0 && expect(close) === 0 && c.puppet && w.batch.children.includes(c.puppet.group), `${close.toFixed(0)} metres off -- half of what the top rung holds -- the stag is a puppet in the scene, on the top rung`)
  check(c.puppet.current.getClip().name === c.clip && c.puppet.current.isRunning() && c.puppet.mats.uHue.value === c.hue, 'playing what it is doing, in its own hue', c.clip)
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
  // The band the old card tier covered: a stag this far off is still a puppet, on the bottom rung.
  const out = reach(LOD_RUNGS - 1) * 0.9
  const mid = settle(out)
  check(mid === expect(out) && mid === LOD_RUNGS - 1 && c.puppet, `and ${out.toFixed(0)} metres off, just inside the cull, it is still its own animated puppet on the last rung, not a photograph of one`)
  {
    const inSight = alive(w).filter((a) => a.lod < LOD_RUNGS)
    check(inSight.length > 0 && inSight.every((a) => a.puppet) && w.batch.children.length === inSight.length, 'every animal in sight wears a puppet, and the batch draws those and nothing else', `${inSight.length} drawn of ${alive(w).length}, ${w.starved} starved`)
  }
  const far = reach(LOD_RUNGS - 1) * 4
  check(settle(far) === LOD_RUNGS && expect(far) === LOD_RUNGS && !c.puppet, `${far.toFixed(0)} metres off, four times the cull, it is not drawn at all`)
  check(w.species.every((sp) => sp.freePuppets.length + sp.puppets.filter((p) => p.group.parent === w.batch).length === PUPPETS), 'the pools balance')
  at(close, 4)
  const t = c.puppet.mixer.time
  at(close, 10, 1 / 60)
  check(c.puppet && Math.abs(c.puppet.mixer.time - t - 10 / 60) < 1e-9, "a puppet's mixer advances with the frames", `${(c.puppet.mixer.time - t).toFixed(4)} s in ten`)
}

// --- the ladder is a ratio of the body --------------------------------------------
//
// FOUR RUNGS, each twice as far off as the one above it, and every distance in
// it measured in body sizes rather than in metres -- so one ladder serves a hare,
// a stag and whatever is built next, and a big animal holds its detail further
// out because that is what she sees.
{
  const size = 1.5
  const rungs = Array.from({ length: LOD_RUNGS }, (_, k) => lodReach(size, k))
  check(LOD_RUNGS === 4 && rungs.map((d) => d.toFixed(0)).join(',') === '10,20,40,80', 'a 1.5 m creature is drawn to 10, 20, 40 and 80 metres', rungs.map((d) => `${d.toFixed(1)}`).join(' / '))
  check(rungs.every((d, k) => k === 0 || Math.abs(d / rungs[k - 1] - 2) < 1e-12), 'each rung reaching exactly twice as far as the one above it')
  check(Math.abs(rungs[0] / size - LOD_NEAR) < 1e-12 && [0.5, 3, 7].every((m) => Math.abs(cullRange(size * m) - cullRange(size) * m) < 1e-9), `the whole ladder scales with the body: tier 0 to ${LOD_NEAR.toFixed(2)} body sizes, the cull to ${(LOD_NEAR * 2 ** (LOD_RUNGS - 1)).toFixed(1)}`)
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
  check(scatter(w).every((s) => Math.abs(s.lodSize - s.size * s.sp.bulk) < 1e-12 && s.cull === cullRange(s.lodSize) && s.forget === forgetRange(s.lodSize)), 'and every spawn carries its own cull and forget, rolled with it')
  // A cull only bites inside the tile horizon -- RADIUS plus half a tile's diagonal. The big ones are taken by their tile unloading instead.
  const horizon = RADIUS + (TILE * Math.SQRT2) / 2
  const culls = scatter(w).map((s) => s.cull)
  check(Math.min(...culls) < horizon / 3, 'and the small of them are culled by the ladder well inside the world, the big by their tile', `${Math.min(...culls).toFixed(0)} m at the near end of the roll, ${Math.max(...culls).toFixed(0)} at the far, of a ${horizon.toFixed(0)} m horizon`)
}

// --- past the cull it is not thought about either ----------------------------------
//
// The cull is one rule with two consequences: a creature she cannot see is not
// drawn AND NOT SIMULATED. Nothing walks, turns, probes the ground or picks an
// activity out there. Where it had got to is remembered while it might matter,
// and dropped when it cannot.
{
  const k = make(7)
  k.place(0, 0)
  const c = beside(k, 'hare')
  const spawn = c.spawn
  const dt = 1 / 60
  // Ten seconds of roaming with her walking beside it, to take it somewhere other than home.
  k._begin(c, 'roam')
  c.left = 100
  for (let f = 0; f < 600; f++) k.update(c.x, c.y + 1.6, c.z, dt)
  const at = { x: c.x, y: c.y, z: c.z, heading: c.heading, left: c.left, clip: c.clip }
  check(Math.hypot(c.x - c.homeX, c.z - c.homeZ) > 1, 'a hare she has watched for ten seconds is no longer standing at home', `${Math.hypot(c.x - c.homeX, c.z - c.homeZ).toFixed(2)} m off it`)

  // Out past the cull, but not past where the placement is worth keeping.
  const eye = { x: at.x + (spawn.cull + spawn.forget) / 2, y: at.y + 1.6, z: at.z }
  for (let f = 0; f < 240; f++) k.update(eye.x, eye.y, eye.z, dt)
  check(c.spawn === spawn && c.lod === LOD_RUNGS && !c.puppet, `${spawn.cull.toFixed(0)} m off, past the cull, the hare is not drawn but the slot is still hers`)
  check(c.x === at.x && c.z === at.z && c.y === at.y && c.heading === at.heading && c.left === at.left && c.clip === at.clip, 'and in four seconds of it nothing walked, turned, read the ground or picked an activity -- it stands exactly where it stood')
  k.update(at.x, at.y + 1.6, at.z, 0)
  check(c.spawn === spawn && c.x === at.x && c.z === at.z, 'she comes back and it is where she left it')

  // And out past where it is worth keeping.
  for (let f = 0; f < 240; f++) k.update(at.x + spawn.forget * 1.2, at.y + 1.6, at.z, dt)
  check(spawn.slot === null && c.spawn === null && k.species.find((sp) => sp.key === 'hare').free.includes(c), `${Math.round((CULL_KEEP - 1) * 100)}% past the cull the slot goes back in the pool`, `${spawn.forget.toFixed(0)} m`)
  check(scatter(k).includes(spawn), 'but the tile still holds the spawn -- where it stands when nothing has moved it is not a thing that can be forgotten')
  const home = { x: spawn.x, z: spawn.z }
  k.update(spawn.x, spawn.y + 1.6, spawn.z, 0)
  const again = k.species.find((sp) => sp.key === 'hare').slots.find((s) => s.spawn === spawn)
  check(again && again.x === home.x && again.z === home.z && Math.hypot(home.x - at.x, home.z - at.z) > 1, 'and the next waking stands it at home again, the wandering forgotten', `${Math.hypot(home.x - at.x, home.z - at.z).toFixed(2)} m from where it was`)
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
  const run = (d, frames = 1, dt = 1 / 60) => { for (let f = 0; f < frames; f++) w.update(c.x, c.y + d, c.z, dt) }
  const vis = () => (c.puppet ? c.puppet.meshes.map((m, k) => (m.visible ? k : -1)).filter((k) => k >= 0) : [])
  const close = lodReach(c.spawn.lodSize, 0) / 2
  const out = lodReach(c.spawn.lodSize, LOD_RUNGS - 1) * 0.9
  const gone = lodReach(c.spawn.lodSize, LOD_RUNGS - 1) * 4

  run(close, 40)
  const p = c.puppet
  check(p && vis().join() === '0' && p.meshes[0].material === p.mats.plain && p.mats.uCut.value === 1, 'settled on a rung, an animal draws that one tier and draws it through the plain material')

  run(out, 1)
  const both = vis()
  check(both.length === 2 && both[0] === 0 && both[1] === LOD_RUNGS - 1 && p.meshes[both[0]].material === p.mats.out && p.meshes[both[1]].material === p.mats.in && p.mats.uCut.value > 0 && p.mats.uCut.value < 1,
    'a step down the ladder draws both rungs at once, the old one masked out and the new one in', `tiers ${both.join(' and ')}, cut ${p.mats.uCut.value.toFixed(2)}`)
  run(out, Math.ceil(LOD_FADE_S * 60) + 2)
  check(vis().join() === String(LOD_RUNGS - 1) && p.meshes[LOD_RUNGS - 1].material === p.mats.plain && p.mats.uCut.value === 1, 'and once it is over only the new rung is left, back on the plain material')

  // Straight off the last rung to nothing: the far side of the same one fade.
  run(gone, 1)
  check(c.lod === LOD_RUNGS && c.puppet === p && vis().length === 1 && p.meshes[vis()[0]].material === p.mats.out && p.mats.uCut.value < 1,
    'past the last rung an animal is not switched off but dissolved, and holds its puppet -- walking, turning, animating -- while it goes')
  let frames = 1
  while (c.puppet && frames < 120) { run(gone, 1); frames++ }
  check(!c.puppet && Math.abs(frames / 60 - LOD_FADE_S) < 3 / 60, `a vanishing takes LOD_FADE_S however far the step was -- a teleport dissolves too`, `${(frames / 60).toFixed(3)} s for a ${(gone - out).toFixed(0)} m jump`)
  check(w.species.every((sp) => sp.freePuppets.length === PUPPETS), 'and every puppet is back in its pool once nothing is in sight')
}

// A TILE UNLOAD IS THE OTHER WAY AN ANIMAL GOES, and for everything but a hare
// it is the usual one: the last rung reaches past where a tile can still be
// loaded, so a stag walked out of range is a stag whose tile unloaded. The
// puppet has to outlive the animal or that is a pop.
{
  w.place(0, 0)
  wake(w)
  const c = alive(w).find((a) => a.sp.key === 'stag')
  for (let f = 0; f < 40; f++) w.update(c.x, c.y + 20, c.z, 1 / 60)
  const p = c.puppet
  check(p && p.meshes.filter((m) => m.visible).length === 1, 'a stag close by is drawn')

  // Her head 400 m away: every tile unloads, so the animal is gone from the world entirely.
  w.update(c.x + 400, c.y, c.z + 400, 1 / 60)
  check(c.spawn === null && !c.puppet, 'walk far enough and its tile unloads, taking the animal with it')
  check(w.fading.some((f) => f.puppet === p), 'but its body stays behind, dissolving where it stood', `${w.fading.length} bodies fading`)
  const vis = p.meshes.filter((m) => m.visible)
  check(vis.length === 1 && vis[0].material === p.mats.out && p.mats.uCut.value < 1 && p.group.parent, 'drawn through the dissolving-out material, still in the batch, on its way out rather than switched off')
  const stags = w.fading.filter((f) => f.sp.key === 'stag').length
  check(stags > 0 && w.species.find((sp) => sp.key === 'stag').freePuppets.length === PUPPETS - stags, 'and is nobody else\'s puppet until it has gone')

  let frames = 1
  while (w.fading.length && frames < 120) { w.update(c.x + 400, c.y, c.z + 400, 1 / 60); frames++ }
  check(!w.fading.length && Math.abs(frames / 60 - LOD_FADE_S) < 3 / 60, 'the fade takes LOD_FADE_S like any other', `${(frames / 60).toFixed(3)} s`)
  check(!p.group.parent && w.species.every((sp) => sp.freePuppets.length === PUPPETS), 'and then it leaves the batch and goes back to the pool')

  // The terrain rebuild is the one case that does not fade: the ground the body was standing on is not there any more.
  for (let f = 0; f < 40; f++) w.update(0, 20, 0, 1 / 60)
  const drawn = alive(w).filter((a) => a.puppet)
  check(drawn.length > 0, 'animals are drawn again around her')
  w.place(0, 0)
  check(!w.fading.length && w.species.every((sp) => sp.freePuppets.length === PUPPETS) && drawn.every((a) => !a.puppet), 'a place() takes every puppet back at once, fading ones included -- the ground they stood on has moved')
}

console.log(failures ? `\n${failures} failing` : '\nall wildlife checks pass')
process.exit(failures ? 1 : 0)
