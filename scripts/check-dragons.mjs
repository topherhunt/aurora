// Node-side gates for the dragons (src/v2/render/dragons.js) and their roosts
// (src/v2/render/roosts.js).
//
//   node scripts/check-dragons.mjs
//
// The shipped fen-dragon GLB is checked for shape first -- the halving ladder
// over one skeleton, the wyvern clip library with `fly` in it, the wyvern
// extras at the roster's size, a bind pose standing four-square on y = 0
// facing +X -- because the world loads it by name and builds every puppet from
// it. Then the roost: a bank of four mesh tiers each in two groups (bark, then
// stone) with a four-triangle card under them whose one profile spins to her
// and whose other lies flat, and a scatter on a flat field that is one per
// 160 000 square metres, the same twice, and turned away by a slope, a tarn or
// a road. Then the dragon itself, on a stand-in slab whose `fly` swings its
// wings out, over a stand-in roost and a stand-in herd: that it is born on its
// nest, flies its loop -- patrol, hunt, strike, seize, return, land -- and
// comes home with the stag hanging from it, drawn every frame it is carried
// and dropped at the next takeoff; that it never turns, pitches, banks or
// speeds faster than its rates and never flies into the ground; that a stag
// that leaves the world sends it back on patrol; that it is drawn as a puppet
// near, as two crossed cards fixed in its body's frame far, and as nothing
// past that while still being simulated; that it goes with its roost, and that
// a relief edit drops what it carried without a fade.
//
// What this can NOT check: whether a dragon coming over the ridge is a thing
// to see. That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import {
  Dragons, CLIPS, DRAGON_VIEWS, MAX, PUPPETS, SIZE_VARY, PATROL_MPS, HUNT_MPS, DIVE_MPS, LAND_MPS, ACCEL,
  TURN_RATE, LAND_TURN_RATE, PITCH_MAX, DIVE_PITCH, PITCH_RATE, BANK, ROLL_RATE, PATROL_M, MIN_AGL, HUNT_M,
  STRIKE_M, LAND_M, REST_S, FLIGHT_S, measureFly,
} from '../src/v2/render/dragons.js'
import {
  Roosts, DENSITY, TILE, DIAMETER, LODS, RUNGS, roostBank, roostLadder,
} from '../src/v2/render/roosts.js'
import { CARD_RUNGS, CRITTER_GLB, LOD_RUNGS, cullRange, lodReach } from '../src/v2/render/critters.js'
import { CREATURES, shipTexPx } from '../tools/creatures/creature-roster.mjs'
import { readAccessor, readGlb } from '../tools/creatures/apply-rig-edit.mjs'
import { webpSize } from '../tools/tripo-pack.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const swing = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a))
const fmt = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v))

// --- the shipped asset ---------------------------------------------------------------
const url = CRITTER_GLB.dragon
const file = new URL(`../public/${url}`, import.meta.url)
if (!fs.existsSync(file)) {
  console.log(` FAIL ${url} is shipped -- run tools/creatures/ship-wyvern.mjs\n\n1 failing -- the GLB must ship before the dragons can be checked`)
  process.exit(1)
}
const { json, bin } = readGlb(file)
const id = url.replace(/^creatures\//, '').replace(/\.glb$/, '')
const roster = CREATURES.find((c) => c.id === id)
let wyvern = null
{
  const meshes = json.meshes ?? []
  const names = meshes.map((m) => m.name)
  check(meshes.length === LOD_RUNGS && names.join(',') === [id, ...Array.from({ length: LOD_RUNGS - 1 }, (_, k) => `${id}-lod${k + 1}`)].join(','), `${id}: one mesh per rung of the ladder, the rig then lod1 up, in the one file`, names.join(','))
  const prim = meshes[0]?.primitives[0]
  const tris = meshes.map((m) => (m.primitives[0] ? json.accessors[m.primitives[0].indices].count / 3 : 0))
  check(tris.every((t, k) => k === 0 || Math.abs(t - tris[k - 1] / 2) <= 2), `${id}: each rung is half the triangles of the one above, within a triangle or two`, tris.join('/'))
  check(meshes.every((m) => m.primitives.length === 1 && m.primitives[0].attributes.JOINTS_0 !== undefined && m.primitives[0].attributes.WEIGHTS_0 !== undefined && m.primitives[0].attributes.NORMAL !== undefined && m.primitives[0].attributes.TEXCOORD_0 !== undefined && m.primitives[0].material === 0), `${id}: every rung is skinned, one primitive, on the one material`)
  const skinned = (json.nodes ?? []).filter((n) => n.skin !== undefined)
  check(json.skins?.length === 1 && skinned.length === LOD_RUNGS && skinned.every((n) => n.skin === 0), `${id}: ONE skeleton, worn by every rung`, `${json.skins?.[0]?.joints.length} joints`)

  const clips = (json.animations ?? []).map((a) => a.name)
  const library = fs.readdirSync(new URL('../tools/creatures/anim/clips/wyvern/', import.meta.url)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
  check(library.every((n) => clips.includes(n)) && clips.length === library.length, `${id}: the whole wyvern clip library, ${library.length} clips`, clips.join(' '))
  check(CLIPS.every((n) => clips.includes(n)) && CLIPS.includes('fly'), `${id}: including every clip the layer plays, fly among them`, CLIPS.join(' '))
  const joints = new Set(json.skins?.[0]?.joints ?? [])
  check((json.animations ?? []).every((a) => a.channels.every((ch) => joints.has(ch.target.node))), `${id}: every clip channel targets a joint of the skeleton`)
  const durs = Object.fromEntries((json.animations ?? []).map((a) => [a.name, Math.max(...a.samplers.map((s) => json.accessors[s.input].max[0]))]))
  check((json.animations ?? []).every((a) => a.samplers.every((s) => json.accessors[s.input].min !== undefined)) && Object.values(durs).every((d) => d > 0.2), `${id}: every sampler carries min and max, and no clip is shorter than 0.2 s`, Object.entries(durs).map(([n, d]) => `${n} ${d.toFixed(2)}`).join(' '))

  wyvern = json.scenes?.[json.scene ?? 0]?.extras?.wyvern
  check(wyvern !== undefined && wyvern.span > 0 && wyvern.height > 0 && wyvern.width > 0 && wyvern.sizeM === roster.sizeM && wyvern.frame && Number.isFinite(wyvern.frame.yaw), `${id}: the scene carries the wyvern extras, at the roster's ${roster.sizeM} m`, wyvern && `span ${wyvern.span.toFixed(3)} width ${wyvern.width.toFixed(3)} height ${wyvern.height.toFixed(3)} yaw ${wyvern.frame.yaw.toFixed(3)}`)
  check(wyvern && wyvern.gait.walk > 0 && wyvern.gait.run > wyvern.gait.walk && Object.keys(wyvern.gait).length === 2, `${id}: walk and run carry a ground speed each, walk under run, and nothing else does`, wyvern && Object.entries(wyvern.gait).map(([n, v]) => `${n} ${v.toFixed(3)}`).join(' '))

  // The bind pose IS the POSITION accessor, so the frame the root joint carries can be checked by applying it: the body stands on y = 0, centred, its length along +X.
  if (wyvern && prim) {
    const p = readAccessor(json, bin, prim.attributes.POSITION)
    const c = Math.cos(wyvern.frame.yaw), s = Math.sin(wyvern.frame.yaw)
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.length; i += 3) {
      const v = [c * p[i] + s * p[i + 2] + wyvern.frame.t[0], p[i + 1] + wyvern.frame.t[1], -s * p[i] + c * p[i + 2] + wyvern.frame.t[2]]
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]) }
    }
    const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
    check(Math.abs(lo[1]) < 1e-4 && Math.abs(lo[0] + hi[0]) < 1e-4 && Math.abs(lo[2] + hi[2]) < 1e-4, `${id}: framed, the bind pose stands on y = 0 with its feet under its middle`, `y from ${lo[1].toExponential(2)}, mid x ${((lo[0] + hi[0]) / 2).toExponential(2)} z ${((lo[2] + hi[2]) / 2).toExponential(2)}`)
    check(Math.abs(ext[0] - wyvern.span) < 1e-4 && Math.abs(ext[1] - wyvern.height) < 1e-4 && Math.abs(ext[2] - wyvern.width) < 1e-4 && ext[0] > ext[2] && ext[2] > ext[1], `${id}: the extras are those extents, and the body is longer than it is wide and wider than it is tall -- it stands four-square, facing +X`, `${ext.map((e) => e.toFixed(3)).join(' x ')}`)
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
if (!wyvern) {
  console.log(`\n${failures} failing -- the extras must ship before the dragons can be checked`)
  process.exit(1)
}

// --- the roost's bank ----------------------------------------------------------------
console.log('\nroost bank')
{
  const bank = roostBank(7)
  const again = roostBank(7)
  const other = roostBank(8)
  const tris = bank.tiers.map((t) => t.geometries[0].index.count / 3)
  check(bank.tiers.length === RUNGS && RUNGS === LODS + 1, `${LODS} mesh tiers and the card under them, ${RUNGS} rungs`, tris.join('/'))
  check(tris.slice(0, LODS).every((t, k) => k === 0 || t < tris[k - 1]), 'every mesh tier is fewer triangles than the one above')
  const grouped = bank.tiers.slice(0, LODS).every((t) => {
    const g = t.geometries[0].groups
    return g.length === 2 && g[0].materialIndex === 0 && g[1].materialIndex === 1 && g[0].count > 0 && g[1].count > 0 && g[0].start === 0 && g[1].start === g[0].count && g[0].count + g[1].count === t.geometries[0].index.count
  })
  check(grouped, 'each mesh tier is two groups over the one index, the branches on bark first and the rocks on stone after, covering every triangle')
  const card = bank.tiers[LODS].geometries[0]
  const spin = card.getAttribute('aSpin')
  check(card.index.count === 12 && card.getAttribute('position').count === 8, 'the card tier is four triangles on eight vertices: two quads', `${card.index.count / 3} tris`)
  check(spin && Array.from(spin.array).join(',') === '1,1,1,1,0,0,0,0', 'one quad spins to her (aSpin 1) and the other lies flat as the top view (aSpin 0)', spin && Array.from(spin.array).join(','))
  check(bank.bounds.halfX > 0 && bank.bounds.halfZ > 0 && bank.bounds.height > 0 && bank.bounds.height < bank.bounds.halfX, 'the bank carries the bowl\'s bounds, a low mound wider than it is tall', `${fmt(bank.bounds.halfX)} x ${fmt(bank.bounds.height)} x ${fmt(bank.bounds.halfZ)}`)
  const same = (a, b) => a.tiers.every((t, k) => { const p = t.geometries[0].getAttribute('position').array, q = b.tiers[k].geometries[0].getAttribute('position').array; return p.length === q.length && p.every((v, i) => v === q[i]) })
  check(same(bank, again) && !same(bank, other), 'the bank is a function of its seed: the same twice, another with another seed')
  check(bank.bytes > 0 && bank.bytes < 512 * 1024, 'the whole bank is under half a megabyte', `${Math.round(bank.bytes / 1024)} KB`)
  const ladder = roostLadder(7)
  check(ladder.geometries.length === LODS && ladder.geometries.every((g) => g.boundingBox && g.getAttribute('normal') && g.getAttribute('uv')), 'every mesh tier carries normals, UVs for the tiles and a bounding box')
}

// --- the roost's scatter --------------------------------------------------------------
console.log('\nroost scatter')
const DRY = { isSubmerged: () => false }
const WET = { isSubmerged: () => true }
const LAYERS = { paths: { nearest: () => null }, snow: { base: 900, band: 40 }, flattenAt: () => 0 }
const ROADS = { paths: { nearest: () => ({ dist: 0, halfWidth: 3 }) }, snow: LAYERS.snow, flattenAt: () => 0 }
const flatField = (h, tan = 0) => ({ heightAt: () => h, heightAndSlopeAt: () => ({ h, tan }) })
const GROUND = 12
const roostsOn = (field, water, layers, seed) => {
  const r = new Roosts(new THREE.Scene(), field, water, layers, { seed })
  r.place(0, 0)
  return r
}
{
  const r = roostsOn(flatField(GROUND), DRY, LAYERS, 5)
  const compile = (m) => {
    const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <clipping_planes_fragment>\n#include <map_fragment>\n' }
    m.onBeforeCompile(shader)
    return shader
  }
  check(r.materials.length === 3 && r.materials[0].customProgramCacheKey() === 'gen-prop-roost-bark' && r.materials[1].customProgramCacheKey() === 'gen-prop-roost-stone' && r.materials[2].customProgramCacheKey() === 'gen-prop-roost-billboard-mixed', 'three materials offered to the lighting: bark, stone, and the mixed card', r.materials.map((m) => m.customProgramCacheKey()).join(' '))
  const cardShader = compile(r.card)
  check(cardShader.vertexShader.includes('attribute float aSpin') && !r.card.visible && r.card.map === null, 'the card program reads aSpin to spin one quad and leave the other, and is not drawn until it is photographed')
  check(r.radius === cullRange(DIAMETER[1], RUNGS) && r.radius > 500, `the scatter reaches the card cull of the widest bowl, ${r.radius.toFixed(0)} m, so nothing of it pops in at the edge`)
  check(r.batch.name === 'v2-roosts' && r.batch._max === r.stats.pool && r.batch.meshes.length === RUNGS && r.stats.pool > r.stats.tiles, 'the arena is one batch, a mesh a rung, sized to a roost a resident tile plus the fades in flight', `pool ${r.stats.pool} over ${r.stats.tiles} tiles`)

  // The rate over forty seeds against the tiles' own area: one to DENSITY, with a binomial's slack.
  let placed = 0, tiles = 0
  for (let seed = 1; seed <= 40; seed++) {
    const q = roostsOn(flatField(GROUND), DRY, LAYERS, seed)
    placed += q.stats.placed
    tiles += q.stats.tiles
    q.dispose()
  }
  const expected = tiles * TILE * TILE * DENSITY
  check(Math.abs(placed - expected) < 3.5 * Math.sqrt(expected), `over forty seeds the scatter is one roost to ${1 / DENSITY} square metres`, `${placed} over ${tiles} tiles, expected ${expected.toFixed(0)}`)

  const sites = r.sites()
  const again = roostsOn(flatField(GROUND), DRY, LAYERS, 5).sites()
  check(sites.length === r.stats.placed && sites.length > 3 && JSON.stringify(sites) === JSON.stringify(again), 'sites() lists every placed roost, and the same seed lays the same roosts twice', `${sites.length} sites`)
  check(sites.every((s) => Number.isFinite(s.key) && s.r >= DIAMETER[0] / 2 && s.r <= DIAMETER[1] / 2), `every site carries its tile key and a rim radius from ${DIAMETER[0] / 2} to ${DIAMETER[1] / 2} m`)
  check(sites.every((s) => s.y < GROUND && s.y > GROUND - 0.1 * s.r), 'and a floor a little under the turf, the bottom branches bedded in')
  check(new Set(sites.map((s) => s.key)).size === sites.length && sites.every((s) => r.tiles.get(s.key)?.site === s), 'one roost to a tile at most, each keyed by its tile')

  r.update(sites[0].x, GROUND + 1.7, sites[0].z)
  const near = r.tierAt[r.tiles.get(sites[0].key).ids[0]]
  // The farthest roost still inside its OWN cull: past that the rim hides it and it has no tier.
  const off = (s) => Math.hypot(s.x - sites[0].x, s.z - sites[0].z)
  const farSite = r.sites().filter((s) => off(s) < cullRange(s.r * 2, RUNGS) * 0.9).reduce((a, b) => (off(b) > off(a) ? b : a))
  const far = r.tierAt[r.tiles.get(farSite.key).ids[0]]
  check(near === 0 && far > near && r.stats.tris > 0, 'a frame later the roost at her feet is on the top tier and the farthest in sight on a lower one, and the triangles are counted', `near tier ${near}, far tier ${far} at ${off(farSite).toFixed(0)} m`)
  const resident = r.sites().length
  check(r.place(sites[0].x, sites[0].z) === r.stats.placed && r.sites().length === resident, 'a relief edit under the same camera lays the same set again', `${resident} sites`)
  r.update(sites[0].x + 4000, GROUND + 1.7, sites[0].z)
  check(r.sites().every((s) => !sites.includes(s)) && r.stats.used === r.stats.placed, 'walked 4 km off, every roost she left is released and the pool holds only what stands')
  r.dispose()

  const steep = roostsOn(flatField(GROUND, Math.tan((30 * Math.PI) / 180)), DRY, LAYERS, 5)
  const wet = roostsOn(flatField(GROUND), WET, LAYERS, 5)
  const road = roostsOn(flatField(GROUND), DRY, ROADS, 5)
  check(steep.stats.placed === 0 && steep.stats.rejected.slope === sites.length, 'a 30-degree slope takes every roost, counted against the slope', JSON.stringify(steep.stats.rejected))
  check(wet.stats.placed === 0 && wet.stats.rejected.water === sites.length, 'so does water', JSON.stringify(wet.stats.rejected))
  check(road.stats.placed === 0 && road.stats.rejected.path === sites.length, 'so does a road through every candidate', JSON.stringify(road.stats.rejected))
  for (const q of [steep, wet, road]) q.dispose()
}

// --- a stand-in dragon: a slab on two bones whose fly swings its wings out ------------
function makeAsset() {
  const root = new THREE.Bone(); root.name = 'Root'
  const spine = new THREE.Bone(); spine.name = 'Spine'; spine.position.set(0.2, 0.1, 0)
  root.add(spine); root.updateMatrixWorld(true)
  const bones = [root, spine]
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  const { span, width, height } = wyvern
  const tiers = Array.from({ length: LOD_RUNGS }, (_, k) => {
    const g = new THREE.BoxGeometry(span, height, width, LOD_RUNGS - k, 1, 1).translate(0, height / 2, 0)
    const n = g.getAttribute('position').count
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2))
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4))
    return g
  })
  // fly yaws the slab a quarter turn at its middle, so in the air it reaches wider across than its standing span, as spread wings do.
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
  const clips = CLIPS.map((name) => {
    const dur = name === 'fly' ? 0.9 : 3
    const tracks = name === 'fly'
      ? [new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, dur / 2, dur], [0, 0, 0, 1, q.x, q.y, q.z, q.w, 0, 0, 0, 1])]
      : [new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, dur], [0, 0, 0, 1, 0, 0, 0, 1])]
    return new THREE.AnimationClip(name, dur, tracks)
  })
  return { root, skeleton, tiers, clips, map: null, sizeM: wyvern.sizeM, span, width, height, gait: { ...wyvern.gait } }
}

/** A stand-in herd: `stags` the slots a dragon may find, seize, carry and drop, every call counted on the slot. */
function makeHerd(stags) {
  return {
    stags,
    prey(x, z, range) {
      let best = null, bestD = range
      for (const s of stags) {
        if (!s.spawn) continue
        const d = Math.hypot(s.x - x, s.z - z)
        if (d < bestD) { best = s; bestD = d }
      }
      return best
    },
    seize(c) { c.spawn = null; c.act = 'dead'; c.seized++; return c },
    carry(c, m, dist, dt) {
      c.carried++
      c.at.setFromMatrixPosition(m)
      c.x = c.at.x; c.y = c.at.y; c.z = c.at.z
      c.carryDist = dist; c.carryDt = dt
    },
    drop(c, fade = true) { c.drops.push(fade) },
  }
}
const stag = (x, z, y = GROUND) => ({ spawn: {}, x, y, z, k: 0.5, size: 2, lod: 0, seized: 0, carried: 0, drops: [], at: new THREE.Vector3() })
const roostOf = (sites) => ({ sites: (into = []) => { into.push(...sites); return into } })
const dragonsOn = (field, sites, herd, seed = 3) => new Dragons(new THREE.Scene(), field, { seed, roosts: roostOf(sites), wildlife: herd, asset: makeAsset() })
const DT = 1 / 60
const HER = { x: 5, y: GROUND + 1.6, z: 5 }

// --- construction ----------------------------------------------------------------------
console.log('\ndragons')
{
  const flat = flatField(GROUND)
  check((() => { try { new Dragons(new THREE.Scene(), flat, { roosts: roostOf([]), wildlife: {}, asset: makeAsset() }); return false } catch (e) { return /prey, seize, carry and drop/.test(e.message) } })(), 'a wildlife without the prey hooks is refused by name')
  check((() => { try { new Dragons(new THREE.Scene(), flat, { roosts: {}, wildlife: makeHerd([]), asset: makeAsset() }); return false } catch (e) { return /sites/.test(e.message) } })(), 'so is a roost layer with no sites()')

  const d = dragonsOn(flat, [], makeHerd([]))
  const fly = measureFly(makeAsset())
  check(fly.halfX > 0 && fly.halfZ > 0 && fly.maxY > fly.minY && fly.halfZ * 2 > wyvern.width && fly.halfX * 2 > wyvern.span, 'the fly pose is measured on the CPU, and it reaches wider than the standing body every way', `half ${fmt(fly.halfX)} x ${fmt(fly.halfZ)}, y ${fmt(fly.minY)} to ${fmt(fly.maxY)}, widest at ${fmt(fly.spreadAt)} s`)
  check(fly.spreadAt > 0 && fly.spreadAt < 0.9, 'and the photograph is taken at the frame the wings reach widest, not the folded first one')
  check(d.bulk > 1 && Math.abs(d.bulk - Math.max(2 * fly.halfX, 2 * fly.halfZ, fly.maxY - fly.minY) / wyvern.span) < 1e-9, 'the ladder is sized by the flying body\'s largest extent over the shipped span, and so reaches farther than the standing body would', `bulk ${d.bulk.toFixed(3)}`)
  check(d.materials.length === 2 * PUPPETS + 2 && d.materials[0] === d.plain && d.materials[d.materials.length - 1] === d.cardMaterial, 'one settled material, a dissolving pair a puppet, and the card, all offered to the lighting', `${d.materials.length}`)
  check(d.plain.customProgramCacheKey() === 'dragons' && d.puppetMats.every((m) => m.plain === d.plain && m.in.customProgramCacheKey() === 'dragons-fade'), 'every puppet draws its settled tiers through THE ONE material and dissolves through the one fade program')
  check(d.cardMaterial.customProgramCacheKey() === 'dragons-card-fade-flat', 'the card is its own program: NOT spun to her, dithered, and flat', d.cardMaterial.customProgramCacheKey())
  check(d.puppets.length === PUPPETS && d.freePuppets.length === PUPPETS && d.slots.length === MAX && d.free.length === MAX, `${PUPPETS} puppets and ${MAX} slots, all free`)
  const geo = d.cardMesh.geometry
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  check(geo.index.count === 12 && geo.getAttribute('position').count === 8 && !geo.getAttribute('aSpin'), 'the card is two quads, four triangles, with no spin attribute: the instance matrix is the whole orientation', `${geo.index.count / 3} tris`)
  check(bb.max.x >= fly.halfX && bb.min.x <= -fly.halfX && bb.max.z >= fly.halfZ && bb.min.z <= -fly.halfZ && bb.min.y <= fly.minY && bb.max.y >= fly.maxY && bb.min.y < 0, 'the quads bound the fly pose where it hangs, below the body\'s origin as a flying body does', `y ${fmt(bb.min.y)} to ${fmt(bb.max.y)}`)
  check(d.cardMesh.name === 'v2-dragons-cards' && d.cardMesh.count === 0 && !d.cardMesh.visible && !d.cardMesh.frustumCulled && d.cardMesh.instanceMatrix.usage === THREE.DynamicDrawUsage && d.batch.children.includes(d.cardMesh) && d.batch.children.length === 1, 'the batch holds the card mesh -- empty, not drawn until the cards are photographed -- and otherwise only the puppets it lends out')
  check(DRAGON_VIEWS.join(',') === 'side,top', 'the two pictures are the side and the top', DRAGON_VIEWS.join(' '))
  d.dispose()
}

// --- the loop: born on the nest, out, the kill, home with it -------------------------
{
  const flat = flatField(GROUND)
  const site = { key: 1234, x: 0, y: GROUND, z: 0, r: 4 }
  const stags = [stag(120, 60)]
  const herd = makeHerd(stags)
  const d = dragonsOn(flat, [site], herd)

  d.update(HER.x, HER.y, HER.z, DT)
  const dr = d.byKey.get(site.key)
  check(dr && d.byKey.size === 1 && d.free.length === MAX - 1 && dr.site === site, 'the frame a site is listed a dragon is born to it, keyed by the roost\'s tile')
  check(dr.state === 'roost' && Math.abs(dr.x - site.x) < 1e-9 && Math.abs(dr.z - site.z) < 1e-9 && dr.y > site.y && dr.y < site.y + 0.1 * site.r && dr.clip === 'idle', 'born on its nest, standing a hand over the floor, idling', `y ${fmt(dr.y)} over ${fmt(site.y)}`)
  check(Math.abs(dr.size / wyvern.sizeM - 1) <= SIZE_VARY && Math.abs(dr.k - dr.size / wyvern.span) < 1e-12 && Math.abs(dr.lodSize - dr.size * d.bulk) < 1e-12, `sized within ${SIZE_VARY * 100}% of the roster, the ladder sized by the flying bulk`, `${fmt(dr.size)} m, lod size ${fmt(dr.lodSize)}`)
  check(dr.timer > 0 && dr.timer < REST_S[1] && dr.lod === 0 && dr.puppet, 'part way through its first rest, and wearing a puppet with her beside the nest', `rest left ${fmt(dr.timer)} s`)
  const born = { size: dr.size, heading: dr.heading }
  const twin = dragonsOn(flat, [site], makeHerd([]), 3)
  twin.update(HER.x, HER.y, HER.z, DT)
  check(twin.byKey.get(site.key).size === born.size && twin.byKey.get(site.key).heading === born.heading, 'the same nest holds the same dragon every visit: its size and its first heading are the roost\'s seed')
  twin.dispose()

  // Fly the loop, measuring every frame against the rates.
  const trace = []
  const seen = new Set(['roost'])
  // Every frame measured against the rates, in every state: a landing that snaps level or onto its stand point is a pop on a nest she may be standing beside.
  const worst = { turn: 0, pitch: 0, roll: 0, speed: 0, accel: 0, move: 0, under: Infinity, farFromHome: 0, banked: 0 }
  const AIRBORNE = new Set(['patrol', 'hunt', 'strike', 'return'])
  const prev = { x: dr.x, y: dr.y, z: dr.z, heading: dr.heading, pitch: dr.pitch, roll: dr.roll, speed: dr.speed }
  const measure = () => {
    worst.turn = Math.max(worst.turn, Math.abs(swing(prev.heading, dr.heading)) / DT)
    worst.pitch = Math.max(worst.pitch, Math.abs(dr.pitch - prev.pitch) / DT)
    worst.roll = Math.max(worst.roll, Math.abs(dr.roll - prev.roll) / DT)
    worst.accel = Math.max(worst.accel, Math.abs(dr.speed - prev.speed) / DT)
    worst.speed = Math.max(worst.speed, dr.speed)
    worst.move = Math.max(worst.move, Math.hypot(dr.x - prev.x, dr.y - prev.y, dr.z - prev.z) / DT)
    worst.banked = Math.max(worst.banked, Math.abs(dr.roll))
    if (AIRBORNE.has(dr.state)) worst.under = Math.min(worst.under, dr.y - GROUND)
    worst.farFromHome = Math.max(worst.farFromHome, Math.hypot(dr.x - site.x, dr.z - site.z))
    Object.assign(prev, { x: dr.x, y: dr.y, z: dr.z, heading: dr.heading, pitch: dr.pitch, roll: dr.roll, speed: dr.speed })
  }
  let seizedAt = -1, homeAt = -1, tookOff = -1, t = 0
  let cargoFrames = 0
  for (let i = 0; i < 60 * 900 && homeAt < 0; i++) {
    d.update(HER.x, HER.y, HER.z, DT)
    t += DT
    measure()
    if (dr.cargo) cargoFrames++
    if (!seen.has(dr.state)) {
      seen.add(dr.state)
      trace.push(`${dr.state}@${t.toFixed(1)}s`)
      if (dr.state === 'patrol') tookOff = t
      if (dr.state === 'return') seizedAt = t
    }
    if (dr.state === 'roost' && seen.has('land')) homeAt = t
  }
  check(trace.join(' ').replace(/@[\d.]+s/g, '') === 'patrol hunt strike return land', 'it flies the loop in order: patrol, hunt, strike, return, land, and is home again', trace.join(' '))
  check(homeAt > 0 && homeAt < 300, 'and the whole flight, with a stag 130 m off, takes under five minutes', `${fmt(homeAt)} s`)
  check(tookOff > 0 && tookOff <= REST_S[1] && dr.clip === 'idle', 'off the nest when its rest ran out, and back to idling on it', `took off at ${fmt(tookOff)} s`)
  check(stags[0].seized === 1 && stags[0].spawn === null && stags[0].act === 'dead' && dr.cargo === stags[0] && d.stats.carrying === 1, 'the stag was seized ONCE -- its spawn dead, its slot the dragon\'s cargo -- and is still the cargo on the nest')
  check(worst.speed <= DIVE_MPS + 1e-6 && worst.speed > HUNT_MPS, 'the dive was the fastest it flew, faster than the hunt and no faster than the dive allows', `${fmt(worst.speed)} m/s`)
  check(worst.under > 0.1 && worst.under < 1.001, 'never once in the air was the body under its nest floor, and it climbed off the nest rather than being lifted to its metre of clearance', `lowest ${fmt(worst.under)} m over the ground`)
  check(worst.farFromHome < PATROL_M + 100, `and never strayed much past ${PATROL_M} m from the nest`, `${fmt(worst.farFromHome)} m at most`)
  check(d.stats.forced === 0, 'the landing was flown, not forced by the clock', `forced ${d.stats.forced}`)
  const landed = { x: dr.x, y: dr.y, z: dr.z, pitch: dr.pitch }
  for (let i = 0; i < 60 * 3; i++) { d.update(HER.x, HER.y, HER.z, DT); measure(); cargoFrames++ }
  check(Math.hypot(landed.x - site.x, landed.z - site.z) > 0.01 && Math.abs(dr.x - site.x) < 1e-9 && Math.abs(dr.z - site.z) < 1e-9 && Math.abs(dr.y - (site.y + 0.04 * site.r)) < 1e-9, 'the landing hands over short of the stand point, and three seconds on it is settled exactly on it', `handed over ${fmt(Math.hypot(landed.x - site.x, landed.z - site.z))} m out`)
  check(Math.abs(dr.roll) < 1e-9 && Math.abs(dr.pitch) < 1e-9 && dr.speed === 0, 'standing level and still')
  check(worst.turn <= LAND_TURN_RATE + 1e-6 && worst.pitch <= PITCH_RATE + 1e-6 && worst.roll <= ROLL_RATE + 1e-6 && worst.accel <= ACCEL + 1e-6 && worst.move <= DIVE_MPS * 1.001, 'and no frame of it, landing and settling included, turned, pitched, banked, accelerated or moved the body faster than its rates', `turn ${fmt(worst.turn)}/${LAND_TURN_RATE} pitch ${fmt(worst.pitch)}/${PITCH_RATE} roll ${fmt(worst.roll)}/${ROLL_RATE} accel ${fmt(worst.accel)}/${ACCEL} move ${fmt(worst.move)}/${DIVE_MPS}`)
  check(worst.banked > 0.3 && worst.banked <= BANK + 1e-9, `it banked into its turns, never past ${BANK} rad`, `${fmt(worst.banked)} rad at most`)
  check(seizedAt > 0 && Math.hypot(stags[0].x - site.x, stags[0].z - site.z) < site.r && Math.hypot(stags[0].x - site.x, stags[0].z - site.z) > 0.5 && Math.abs(stags[0].y - dr.y) < 1e-6, 'carried home: the carcass lies on the nest floor beside the dragon, not under it', `at (${fmt(stags[0].x)}, ${fmt(stags[0].y)}, ${fmt(stags[0].z)}), nest r ${site.r}`)
  check(stags[0].carried === cargoFrames && cargoFrames > 60 && stags[0].carryDt === DT && Math.abs(stags[0].carryDist - Math.hypot(stags[0].x - HER.x, stags[0].y - HER.y, stags[0].z - HER.z)) < 1e-6, 'wildlife.carry was called on every frame it was cargo, with the frame and the carcass\'s own distance to her', `${cargoFrames} frames`)
  check(stags[0].drops.length === 0, 'and not dropped yet: the kill lies on the nest through the rest')

  // Rest out, and the next takeoff lets the kill go, with a fade.
  let dropped = -1
  for (let i = 0; i < 60 * (REST_S[1] + 5) && dropped < 0; i++) {
    d.update(HER.x, HER.y, HER.z, DT)
    if (stags[0].drops.length) dropped = i
  }
  check(dropped >= 0 && stags[0].drops.join() === 'true' && dr.cargo === null && dr.state === 'patrol', 'the next takeoff drops the kill where it lies, with a fade, and the dragon patrols empty')
  check(herd.prey(dr.x, dr.z, HUNT_M) === null, 'a seized stag is not prey again')

  // Empty patrol: the flight clock sends it home, and it lands without a stag to chase.
  let home = -1, patrolLow = Infinity, patrolHigh = 0
  for (let i = 0; i < 60 * (FLIGHT_S[1] + 200) && home < 0; i++) {
    d.update(HER.x, HER.y, HER.z, DT)
    if (dr.state === 'patrol' && i > 60 * 20) { patrolLow = Math.min(patrolLow, dr.y - GROUND); patrolHigh = Math.max(patrolHigh, dr.y - GROUND) }
    if (dr.state === 'roost') home = i * DT
  }
  check(home > 0 && home < FLIGHT_S[1] + 150 && !dr.cargo, `with nothing to hunt the patrol turns for home when its clock runs out and lands within ${FLIGHT_S[1]} s and the flight back`, `${fmt(home)} s`)
  check(patrolLow >= MIN_AGL - 5 && patrolHigh > MIN_AGL, `once up, the cruise kept about ${MIN_AGL} m over the ground or higher`, `${fmt(patrolLow)} to ${fmt(patrolHigh)} m`)
  d.dispose()
}

// --- a stag that leaves the world mid-hunt, and a relief edit under a carrying dragon --
{
  const flat = flatField(GROUND)
  const site = { key: 77, x: 0, y: GROUND, z: 0, r: 4 }
  const stags = [stag(150, 0)]
  const herd = makeHerd(stags)
  const d = dragonsOn(flat, [site], herd, 11)
  d.update(HER.x, HER.y, HER.z, DT)
  const dr = d.byKey.get(site.key)
  const until = (state, frames) => { for (let i = 0; i < frames; i++) { d.update(HER.x, HER.y, HER.z, DT); if (dr.state === state) return true } return false }
  check(until('hunt', 60 * 200), 'a dragon on patrol finds a stag inside its range and hunts it')
  stags[0].spawn = null
  d.update(HER.x, HER.y, HER.z, DT)
  check(dr.state === 'patrol' && dr.prey === null && stags[0].seized === 0, 'a stag whose tile unloads mid-hunt sends it back on patrol, unseized')
  stags[0].spawn = {}
  check(until('return', 60 * 200) && dr.cargo === stags[0], 'back in the world, it is hunted again and taken')
  d.place()
  check(stags[0].drops.join() === 'false' && d.byKey.size === 0 && d.free.length === MAX && d.freePuppets.length === PUPPETS && d.fading.length === 0 && d.cardMesh.count === 0, 'a relief edit puts every dragon away at once: the kill dropped with NO fade, every slot and puppet free, nothing dissolving')
  d.update(HER.x, HER.y, HER.z, DT)
  check(d.byKey.size === 1 && d.byKey.get(site.key).state === 'roost', 'and the next frame the roost has its dragon again, on the nest')
  d.dispose()
}

// --- the rungs: puppet near, two fixed cards far, nothing past that, simulated throughout --
{
  const flat = flatField(GROUND)
  const site = { key: 9, x: 0, y: GROUND, z: 0, r: 4 }
  const d = dragonsOn(flat, [site], makeHerd([]), 5)
  d.update(HER.x, HER.y, HER.z, DT)
  const dr = d.byKey.get(site.key)
  const reach = (k) => lodReach(dr.lodSize, k)
  const at = (dist, frames = 90) => { for (let i = 0; i < frames; i++) d.update(site.x + dist, HER.y, site.z, DT); return dr.lod }
  check(at(reach(0) * 0.9) === 0 && dr.puppet && dr.puppet.tier === 0, `inside ${reach(0).toFixed(0)} m it is a puppet on the top tier`)
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
  dr.puppet.group.matrix.decompose(p, q, s)
  check(Math.abs(p.x - dr.x) < 1e-9 && Math.abs(p.y - dr.y) < 1e-9 && Math.abs(p.z - dr.z) < 1e-9 && Math.abs(s.x - dr.k) < 1e-9 && d.batch.children.includes(dr.puppet.group), 'the puppet\'s matrix is the dragon\'s: where it is, at its size, and in the batch')
  check(at(reach(LOD_RUNGS - 1) * 0.9) === LOD_RUNGS - 1 && dr.puppet && dr.puppet.tier === LOD_RUNGS - 1, `at ${(reach(LOD_RUNGS - 1) * 0.9).toFixed(0)} m it is on the bottom mesh tier, still a puppet`)
  check(at(reach(LOD_RUNGS) * 0.9) === LOD_RUNGS && !dr.puppet && d.cardN === 1 && d.cardMesh.count === 1 && d.freePuppets.length === PUPPETS, `at ${(reach(LOD_RUNGS) * 0.9).toFixed(0)} m the puppet is given back and the two cards drawn instead`)
  d.cardMesh.getMatrixAt(0, m)
  m.decompose(p, q, s)
  const e = new THREE.Euler().setFromQuaternion(q, 'YZX')
  check(Math.abs(p.x - dr.x) < 1e-3 && Math.abs(p.y - dr.y) < 1e-3 && Math.abs(p.z - dr.z) < 1e-3 && Math.abs(s.x - dr.k) < 1e-6, 'the card instance stands where the dragon is, at its size')
  check(Math.abs(swing(e.y, dr.heading)) < 1e-6 && Math.abs(e.z - dr.pitch) < 1e-6 && Math.abs(e.x - dr.roll) < 1e-6, 'and carries its whole orientation -- heading, pitch AND roll -- since a fixed pair of quads is turned by its matrix and by nothing else', `yaw ${fmt(e.y)} pitch ${fmt(e.z)} roll ${fmt(e.x)}`)
  check(d.cardFade.array[0] === 1, 'settled: the whole card is drawn, no dither left', `fade ${d.cardFade.array[0]}`)
  const before = { x: dr.x, z: dr.z, state: dr.state }
  check(at(reach(LOD_RUNGS) * 4) === CARD_RUNGS && d.cardN === 0 && d.cardMesh.count === 0 && !dr.puppet && d.byKey.size === 1, `four times the card's reach, it is drawn as nothing at all -- and is still alive`)
  for (let i = 0; i < 60 * 120; i++) d.update(site.x + reach(LOD_RUNGS) * 4, HER.y, site.z, DT)
  check(dr.state !== 'roost' || before.state !== dr.state || dr.x !== before.x || dr.z !== before.z || d.stats.states.roost === 1, 'and still simulated out of sight: two minutes on, it has been about its loop', `now ${dr.state} at (${fmt(dr.x)}, ${fmt(dr.z)})`)
  check(d.stats.alive === 1 && d.stats.lod.length === LOD_RUNGS && d.stats.cards === 0 && typeof d.stats.states === 'object' && d.stats.starved === 0 && d.stats.overflow === 0, 'the stats read alive, a row a mesh rung, the cards, the states and the counters', JSON.stringify(d.stats))
  d.dispose()
}

// --- a roost that goes, too many roosts, and too many in mesh range -------------------
{
  const flat = flatField(GROUND)
  const sites = [{ key: 1, x: 0, y: GROUND, z: 0, r: 4 }]
  const roosts = roostOf(sites)
  const d = new Dragons(new THREE.Scene(), flat, { seed: 2, roosts, wildlife: makeHerd([]), asset: makeAsset() })
  d.update(HER.x, HER.y, HER.z, DT)
  const dr = d.byKey.get(1)
  check(dr && dr.puppet, 'a dragon with her beside its nest wears a puppet')
  sites.length = 0
  d.update(HER.x, HER.y, HER.z, DT)
  check(d.byKey.size === 0 && d.free.length === MAX && dr.site === null && d.fading.length === 1 && d.freePuppets.length === PUPPETS - 1, 'the frame its roost goes the dragon is retired and its body left to dissolve')
  for (let i = 0; i < 60 * 3; i++) d.update(HER.x, HER.y, HER.z, DT)
  check(d.fading.length === 0 && d.freePuppets.length === PUPPETS, 'and the puppet is back in the pool once the dissolve is done')

  for (let k = 0; k < MAX + 1; k++) sites.push({ key: 100 + k, x: k * 8, y: GROUND, z: 0, r: 4 })
  d.update(HER.x, HER.y, HER.z, DT)
  check(d.byKey.size === MAX && d.stats.overflow === 1 && d.free.length === 0, `${MAX + 1} roosts in range is one more dragon than there are slots: ${MAX} fly and the overflow is counted`)
  check(d.stats.puppets === PUPPETS && d.stats.starved > 0 && Array.from(d.byKey.values()).filter((x) => x.puppet).length === PUPPETS, `all of them at her feet, ${PUPPETS} wear puppets and the rest are counted starved rather than drawn wrong`, `starved ${d.stats.starved}`)
  sites.length = 0
  d.update(HER.x, HER.y, HER.z, DT)
  check(d.byKey.size === 0 && d.free.length === MAX && d.fading.length === PUPPETS, 'every roost gone, every dragon retired, the puppets they wore dissolving')
  d.dispose()
  check(d.batch.parent === null && d.freePuppets.length === PUPPETS, 'disposed, the batch is out of the scene and every puppet parked')
}

console.log(`\n${failures} failing`)
process.exit(failures ? 1 : 0)
