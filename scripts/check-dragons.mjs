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
// nest and, hungry, flies the hunt -- patrol, hunt, strike, seize, return,
// land -- and comes home with the stag hanging from it, drawn every frame it
// is carried, laid at one spot on the nest, walked round and eaten; that fed
// it potters on the nest for minutes and then explores rather than hunts,
// alighting on ground away from home that is neither steep nor drowned; that
// it never turns, pitches, banks or speeds faster than its rates, never walks
// faster than its gait and never flies into the ground; that a stag
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
  Dragons, CLIPS, DRAGON_VIEWS, MAX, PUPPETS, SIZE_VARY, CARD_EVERY, PATROL_MPS, HUNT_MPS, DIVE_MPS, LAND_MPS, ACCEL,
  TURN_RATE, LAND_TURN_RATE, PITCH_MAX, DIVE_PITCH, PITCH_RATE, BANK, ROLL_RATE, PATROL_M, MIN_AGL, HUNT_M,
  STRIKE_M, LAND_M, REST_S, FIRST_S, FLIGHT_S, PERCH_S, EAT_S, HUNGER_S, WAY_M, WALK_TURN_RATE, EAT_REACH, SPOT_AWAY, SPOT_SLOPE_DEG, SCALE_ROUGHNESS, measureFly,
  LURES, LURE_M, LURE_FORGET_M, MENACE_RUN_M, MENACE_M,
} from '../src/v2/render/dragons.js'
import {
  Roosts, DENSITY, TILE, DIAMETER, LODS, RUNGS, RADIUS_M, roostBank, roostLadder,
  EGG_GLB, EGG_ODDS, EGG_HEIGHT, EGG_TINTS, EGG_LIE, EGG_SINK, EGG_ROUGHNESS, eggBankFrom,
} from '../src/v2/render/roosts.js'
import { propCull } from '../src/v2/render/gen-props.js'
import { CARD_RUNGS, CRITTER_GLB, GLINT, LOD_RUNGS, cullRange, lodReach } from '../src/v2/render/critters.js'
import { CREATURES, shipTexPx } from '../tools/creatures/creature-roster.mjs'
import { readAccessor, readGlb } from '../tools/creatures/apply-rig-edit.mjs'
import { webpSize } from '../tools/tripo-pack.mjs'
import { taken } from '../src/v2/taken.js'

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
  const jointNames = new Set([...joints].map((j) => json.nodes[j].name))
  check(wyvern?.legs?.length === 2 && wyvern.legs.every((l) => l.chain.length >= 3 && l.chain.every((n) => jointNames.has(n))), `${id}: two legs named, hip to foot, every joint of every chain one of the skeleton's -- the talons a kill hangs from are measured off their feet`, wyvern?.legs && wyvern.legs.map((l) => `${l.id} ${l.chain.join('>')}`).join(' '))

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
// A planar hillside rising gx per metre along +X and gz along +Z.
const hillField = (h0, gx, gz) => ({ heightAt: (x, z) => h0 + gx * x + gz * z, heightAndSlopeAt: (x, z) => ({ h: h0 + gx * x + gz * z, tan: Math.hypot(gx, gz) }) })
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
  check(r.materials.length === 3 && r.materials[0].customProgramCacheKey() === 'gen-prop' && r.materials[1].customProgramCacheKey() === 'gen-prop' && r.materials[2].customProgramCacheKey() === 'gen-prop-billboard-mixed', 'three materials offered to the lighting: bark and stone on the one gen-prop program, and the mixed card', r.materials.map((m) => m.customProgramCacheKey()).join(' '))
  const cardShader = compile(r.card)
  check(cardShader.vertexShader.includes('attribute float aSpin') && !r.card.visible && r.card.map === null, 'the card program reads aSpin to spin one quad and leave the other, and is not drawn until it is photographed')
  check(r.radius === RADIUS_M && r.radius === 400 && lodReach(DIAMETER[1], LODS - 1) < r.radius && r.radius < cullRange(DIAMETER[1], RUNGS), `the scatter reaches ${r.radius} m, past the widest bowl's last mesh rung and short of its card cull, so what comes in at the edge is a card`, `mesh to ${lodReach(DIAMETER[1], LODS - 1).toFixed(0)} m, card to ${cullRange(DIAMETER[1], RUNGS).toFixed(0)} m`)
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
  check(sites.every((s) => s.y < GROUND && s.y > GROUND - 0.1 * s.r && s.gx === 0 && s.gz === 0), 'and a floor a little under the turf, the bottom branches bedded in, lying level on level ground')
  check(new Set(sites.map((s) => s.key)).size === sites.length && sites.every((s) => r.tiles.get(s.key)?.site === s), 'one roost to a tile at most, each keyed by its tile')

  r.update(sites[0].x, GROUND + 1.7, sites[0].z)
  const near = r.tierAt[r.tiles.get(sites[0].key).ids[0]]
  // The farthest roost still inside its OWN cull and the scatter's radius: past either the rim hides it and it has no tier.
  const off = (s) => Math.hypot(s.x - sites[0].x, s.z - sites[0].z)
  const farSite = r.sites().filter((s) => off(s) < Math.min(r.radius, cullRange(s.r * 2, RUNGS)) * 0.9).reduce((a, b) => (off(b) > off(a) ? b : a))
  const far = r.tierAt[r.tiles.get(farSite.key).ids[0]]
  check(near === 0 && far > near && r.stats.tris > 0, 'a frame later the roost at her feet is on the top tier and the farthest in sight on a lower one, and the triangles are counted', `near tier ${near}, far tier ${far} at ${off(farSite).toFixed(0)} m`)
  const resident = r.sites().length
  check(r.place(sites[0].x, sites[0].z) === r.stats.placed && r.sites().length === resident, 'a relief edit under the same camera lays the same set again', `${resident} sites`)
  r.update(sites[0].x + 4000, GROUND + 1.7, sites[0].z)
  check(r.sites().every((s) => !sites.includes(s)) && r.stats.used === r.stats.placed, 'walked 4 km off, every roost she left is released and the pool holds only what stands')
  r.dispose()

  // A 20-degree hillside: every bowl lies on it, tilted to its plane and seated at the ground under its centre, its rim bedded the same depth all round.
  const HILL = Math.tan((20 * Math.PI) / 180)
  const hill = hillField(GROUND, HILL * 0.6, HILL * 0.8)
  const hillside = roostsOn(hill, DRY, LAYERS, 5)
  const hillSites = hillside.sites()
  const m = new THREE.Matrix4()
  const p = new THREE.Vector3()
  let rimOff = 0, tiltOff = 0
  for (const s of hillSites) {
    hillside.batch.getMatrixAt(hillside.tiles.get(s.key).ids[0], m)
    for (const [u, v] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      p.set(u, 0, v).applyMatrix4(m)
      rimOff = Math.max(rimOff, Math.abs(p.y - hill.heightAt(p.x, p.z) + 0.06 * s.r))
    }
    p.set(0, 1, 0).transformDirection(m)
    tiltOff = Math.max(tiltOff, p.distanceTo(new THREE.Vector3(-s.gx, 1, -s.gz).normalize()))
  }
  check(hillSites.length === sites.length && hillSites.every((s) => Math.abs(s.gx - HILL * 0.6) < 1e-9 && Math.abs(s.gz - HILL * 0.8) < 1e-9 && Math.abs(s.y - (hill.heightAt(s.x, s.z) - 0.06 * s.r)) < 1e-9), 'on a 20-degree hillside every site carries the hill\'s own slope and a floor 0.06 r under the ground at its centre', `${hillSites.length} sites`)
  check(rimOff < 1e-4 && tiltOff < 1e-6, 'and every bowl is tilted to the hill, its Y the hill\'s normal and all four rim points bedded exactly 0.06 r into the turf, none buried and none floating', `rim off ${rimOff.toExponential(1)} m, tilt off ${tiltOff.toExponential(1)}`)
  hillside.dispose()

  const steep = roostsOn(flatField(GROUND, Math.tan((30 * Math.PI) / 180)), DRY, LAYERS, 5)
  const wet = roostsOn(flatField(GROUND), WET, LAYERS, 5)
  const road = roostsOn(flatField(GROUND), DRY, ROADS, 5)
  check(steep.stats.placed === 0 && steep.stats.rejected.slope === sites.length, 'a 30-degree slope takes every roost, counted against the slope', JSON.stringify(steep.stats.rejected))
  check(wet.stats.placed === 0 && wet.stats.rejected.water === sites.length, 'so does water', JSON.stringify(wet.stats.rejected))
  check(road.stats.placed === 0 && road.stats.rejected.path === sites.length, 'so does a road through every candidate', JSON.stringify(road.stats.rejected))
  for (const q of [steep, wet, road]) q.dispose()
}

// --- the egg in the nest ----------------------------------------------------------------
console.log('\nroost egg')
{
  const throws = (fn) => { try { fn(); return false } catch { return true } }
  // A stand-in pick the shape of the shipped egg: an ellipsoid on its broad end with its foot on y = 0, as loadCritterGlb frames a pick.
  const pickOf = (w, h, d) => {
    const g = new THREE.SphereGeometry(0.5, 48, 32).scale(w, h, d).translate(0, h / 2, 0)
    return { pos: g.getAttribute('position').array, nrm: g.getAttribute('normal').array, uv: g.getAttribute('uv').array, idx: Array.from(g.index.array), map: null }
  }
  check(fs.existsSync(new URL(`../public/${EGG_GLB}`, import.meta.url)) && fs.existsSync(new URL(`../public/${EGG_GLB.replace(/\.glb$/, '.webp')}`, import.meta.url)), `${EGG_GLB} and its map are shipped -- run tools/props/gen/ship.mjs egg-dragon`)
  check(throws(() => eggBankFrom(pickOf(1, 0.6, 0.6))), 'eggBankFrom refuses a pick lying on its side')
  const egg = eggBankFrom(pickOf(0.6, 1, 0.6))
  const bb = egg.geometry.boundingBox
  check(Math.abs(egg.bounds.height - 1) < 1e-6 && Math.abs(egg.bounds.width - 0.6) < 1e-6 && Math.abs(bb.min.y + 0.5) < 1e-6 && Math.abs(bb.max.y - 0.5) < 1e-6 && egg.tris > 0, 'and takes a standing one, its origin moved from the foot to the middle it is turned about', `${fmt(egg.bounds.width)} x ${fmt(egg.bounds.height)}, y ${fmt(bb.min.y)}..${fmt(bb.max.y)}, ${egg.tris} tris`)
  const c = new THREE.Color()
  check(EGG_TINTS.length === 5 && EGG_TINTS.every(([name, hex]) => typeof name === 'string' && !(c.setHex(hex).r > 0.8 && c.g > 0.8 && c.b > 0.8)), 'five clutch colours, none of them white -- a white tint is the unpainted pick', EGG_TINTS.map(([n]) => n).join(' '))
  check(EGG_ODDS > 0 && EGG_ODDS < 1 && EGG_LIE[0] > 0 && EGG_LIE[1] < Math.PI / 2 && EGG_HEIGHT[0] > 0 && EGG_HEIGHT[1] < 1, 'an egg is a chance, lies over short of flat, and is under a metre tall')

  const eggRoostsOn = (field, water, layers, seed) => {
    const r = new Roosts(new THREE.Scene(), field, water, layers, { seed, egg })
    r.place(0, 0)
    return r
  }
  const r = eggRoostsOn(flatField(GROUND), DRY, LAYERS, 5)
  const bare = roostsOn(flatField(GROUND), DRY, LAYERS, 5)
  check(r.materials.length === 4 && r.materials[3].customProgramCacheKey() === 'gen-prop-gloss' && r.batch.meshes.length === RUNGS + 1 && r.eggTier === RUNGS, 'with a bank the arena grows a tier past the card, the egg on its own gloss gen-prop material', r.materials.map((m) => m.customProgramCacheKey()).join(' '))
  // The shine: a Standard at EGG_ROUGHNESS with no metalness, the whole lobe left on it, and the rim fade still spliced in.
  check(r.eggMaterial.isMeshStandardMaterial && r.eggMaterial.roughness === EGG_ROUGHNESS && EGG_ROUGHNESS > 0 && EGG_ROUGHNESS <= 0.3 && r.eggMaterial.metalness === 0, 'the egg is a Standard material at EGG_ROUGHNESS, no rougher than the wet creatures, with no metalness', `${r.eggMaterial.type} roughness ${r.eggMaterial.roughness}`)
  check(r.materials.slice(0, 3).every((m) => m.isMeshLambertMaterial), 'the roost itself stays Lambert')
  {
    const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <map_fragment>\n#include <normal_fragment_begin>\n#include <lights_fragment_end>\n' }
    r.eggMaterial.onBeforeCompile(shader)
    check(shader.vertexShader.includes('attribute float aPropFade;') && shader.fragmentShader.includes('vPropFade'), 'and dithers out at the rim like every prop')
    check(!shader.fragmentShader.includes('reflectedLight.directSpecular *='), 'with the sun\'s whole lobe on the shell, not the creatures\' halved glint')
  }
  check(JSON.stringify(r.sites()) === JSON.stringify(bare.sites()) && r.stats.placed === bare.stats.placed, 'the eggs move no roost: the same seed lays the same sites with them or without', `${r.stats.placed} sites`)
  check(r.stats.pool === r.batch._max && r.stats.pool > 2 * r.stats.tiles && bare.stats.pool < r.stats.pool, 'and the pool holds a roost and an egg for every resident tile, plus the fades', `pool ${r.stats.pool} over ${r.stats.tiles} tiles`)
  bare.dispose()

  let placed = 0, eggs = 0
  for (let seed = 1; seed <= 40; seed++) {
    const q = eggRoostsOn(flatField(GROUND), DRY, LAYERS, seed)
    placed += q.stats.placed
    eggs += q.stats.eggs
    q.dispose()
  }
  check(eggs > 0 && eggs < placed && Math.abs(eggs - placed * EGG_ODDS) < 3.5 * Math.sqrt(placed * EGG_ODDS * (1 - EGG_ODDS)), `over forty seeds ${EGG_ODDS} of the roosts hold an egg and the rest are empty`, `${eggs} eggs in ${placed} roosts`)

  // Every egg over ten seeds: at its bowl's centre, tinted from the clutch, laid over within EGG_LIE, EGG_HEIGHT tall, and its lowest vertex resting on the floor branches with EGG_SINK of its width bedded in. The matrices come back as float32, so the tolerances are metres of that.
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(), v = new THREE.Vector3()
  const pos = egg.geometry.getAttribute('position')
  const lowest = (matrix) => {
    let low = Infinity
    for (let i = 0; i < pos.count; i++) low = Math.min(low, v.fromBufferAttribute(pos, i).applyMatrix4(matrix).y)
    return low
  }
  const tints = new Set()
  let eggCount = 0, centreOff = 0, restOff = 0, lieLo = Infinity, lieHi = -Infinity, hLo = Infinity, hHi = -Infinity, badScale = 0, badTier = 0, badCull = 0
  for (let seed = 1; seed <= 10; seed++) {
    const w = seed === 5 ? r : eggRoostsOn(flatField(GROUND), DRY, LAYERS, seed)
    for (const t of w.tiles.values()) {
      if (t.n !== 2) continue
      eggCount++
      const id = t.ids[1]
      w.batch.getMatrixAt(id, m)
      m.decompose(p, q, s)
      centreOff = Math.max(centreOff, Math.hypot(p.x - t.site.x, p.z - t.site.z))
      const height = s.y * egg.bounds.height
      const width = s.x * egg.bounds.width
      hLo = Math.min(hLo, height); hHi = Math.max(hHi, height)
      if (Math.abs(s.x - s.y) > 1e-6 || Math.abs(s.z - s.y) > 1e-6 || Math.abs(w.instR[id] - height) > 1e-6) badScale++
      const lie = Math.acos(up.set(0, 1, 0).applyQuaternion(q).y)
      lieLo = Math.min(lieLo, lie); lieHi = Math.max(lieHi, lie)
      restOff = Math.max(restOff, Math.abs(lowest(m) - (t.site.y + 0.04 * t.site.r - EGG_SINK * width)))
      tints.add(w.batch.getColorAt(id, c).getHex())
      if (w.tierAt[id] !== w.eggTier) badTier++
      if (Math.abs(w.rim.gone[id] - Math.min(w.radius, propCull(height))) > 1e-3) badCull++
    }
    if (w !== r) w.dispose()
  }
  check(eggCount > 10 && centreOff < 1e-3, 'every egg lies at its bowl\'s centre', `${eggCount} eggs over ten seeds, centre off ${centreOff.toExponential(1)} m`)
  check(lieLo >= EGG_LIE[0] - 1e-6 && lieHi <= EGG_LIE[1] + 1e-6 && lieHi - lieLo > 0.2, `laid over ${EGG_LIE[0]}..${EGG_LIE[1]} rad off the floor's normal, no two alike`, `lie ${fmt(lieLo)}..${fmt(lieHi)}`)
  check(hLo >= EGG_HEIGHT[0] - 1e-6 && hHi <= EGG_HEIGHT[1] + 1e-6 && hHi - hLo > 0.05 && badScale === 0, `${EGG_HEIGHT[0]}..${EGG_HEIGHT[1]} m tall, scaled evenly, its height its rim size`, `${fmt(hLo)}..${fmt(hHi)} m, ${badScale} scaled unevenly`)
  check(restOff < 0.01, `its lowest point ${EGG_SINK} of its width into the floor branches, on a stand-in ellipsoid's own vertices`, `rest off ${restOff.toExponential(1)} m`)
  check([...tints].every((hex) => EGG_TINTS.some(([, h]) => h === hex)) && tints.size === EGG_TINTS.length, 'every egg tinted one of the clutch colours and every colour showing, so none white', [...tints].map((h) => EGG_TINTS.find(([, x]) => x === h)?.[0]).join(' '))
  check(badTier === 0 && badCull === 0, 'each on the egg tier for good, culled where a prop of its height is', `${badTier} off tier, ${badCull} off cull`)

  const eggTiles = [...r.tiles.values()].filter((t) => t.n === 2)
  r.update(eggTiles[0].site.x, GROUND + 1.7, eggTiles[0].site.z)
  const bareAgain = roostsOn(flatField(GROUND), DRY, LAYERS, 5)
  bareAgain.update(eggTiles[0].site.x, GROUND + 1.7, eggTiles[0].site.z)
  const shown = eggTiles.filter((t) => !r.rim.isHidden(t.ids[1])).length
  check(shown > 0 && r.stats.tris === bareAgain.stats.tris + shown * egg.tris, 'a frame later the eggs in sight are counted whole, over the roosts\' own count', `${shown} eggs shown, ${r.stats.tris} tris against ${bareAgain.stats.tris}`)
  bareAgain.dispose()
  r.update(eggTiles[0].site.x + 4000, GROUND + 1.7, eggTiles[0].site.z)
  check(r.stats.used === r.stats.placed + r.stats.eggs && r.stats.eggs > 0 && [...r.tiles.values()].every((t) => t.n === 0 || t.n === 1 || t.n === 2), 'walked 4 km off, every egg she left is released with its roost and the pool holds what stands', `${r.stats.eggs} eggs in ${r.stats.placed} roosts, ${r.stats.used} used`)
  r.dispose()

  // On the hillside the egg is lifted along the bowl's own normal and laid over from it, its rest measured on the tilted floor.
  const HILL = Math.tan((20 * Math.PI) / 180)
  const hill = hillField(GROUND, HILL * 0.6, HILL * 0.8)
  const n = new THREE.Vector3(), lift = new THREE.Vector3()
  let hillEggs = 0, alongOff = 0, hillLieLo = Infinity, hillLieHi = -Infinity, hillRestOff = 0
  for (let seed = 1; seed <= 10; seed++) {
    const hillside = eggRoostsOn(hill, DRY, LAYERS, seed)
    for (const t of hillside.tiles.values()) {
      if (t.n !== 2) continue
      hillEggs++
      hillside.batch.getMatrixAt(t.ids[1], m)
      m.decompose(p, q, s)
      n.set(-t.site.gx, 1, -t.site.gz).normalize()
      lift.set(p.x - t.site.x, p.y - t.site.y, p.z - t.site.z)
      alongOff = Math.max(alongOff, lift.clone().cross(n).length())
      const lie = Math.acos(up.set(0, 1, 0).applyQuaternion(q).dot(n))
      hillLieLo = Math.min(hillLieLo, lie); hillLieHi = Math.max(hillLieHi, lie)
      // The lowest point over the tilted floor: every vertex's height along the normal, against the floor's.
      let low = Infinity
      for (let i = 0; i < pos.count; i++) low = Math.min(low, v.fromBufferAttribute(pos, i).applyMatrix4(m).sub(p).dot(n))
      hillRestOff = Math.max(hillRestOff, Math.abs(lift.dot(n) + low - (0.04 * t.site.r - EGG_SINK * s.x * egg.bounds.width)))
    }
    hillside.dispose()
  }
  check(hillEggs === eggCount && alongOff < 1e-3, 'on a 20-degree hillside every egg is lifted from its bowl\'s centre along the hill\'s normal', `${hillEggs} eggs, off the normal by ${alongOff.toExponential(1)} m`)
  check(hillLieLo >= EGG_LIE[0] - 1e-6 && hillLieHi <= EGG_LIE[1] + 1e-6 && hillRestOff < 0.01, 'laid over from that normal within EGG_LIE, and resting on the tilted floor', `lie ${fmt(hillLieLo)}..${fmt(hillLieHi)}, rest off ${hillRestOff.toExponential(1)} m`)
}

// --- the egg in her hand ------------------------------------------------------------------
console.log('\nroost egg taken')
{
  const pickOf = (w, h, d) => {
    const g = new THREE.SphereGeometry(0.5, 48, 32).scale(w, h, d).translate(0, h / 2, 0)
    return { pos: g.getAttribute('position').array, nrm: g.getAttribute('normal').array, uv: g.getAttribute('uv').array, idx: Array.from(g.index.array), map: null }
  }
  const egg = eggBankFrom(pickOf(0.6, 1, 0.6))
  taken.clear()
  // Grown and swept from over one nest with an egg -- the first, or the one at (x, z) -- so the eggs in sight are shown.
  const grow = (x = null, z = null) => {
    const r = new Roosts(new THREE.Scene(), flatField(GROUND), DRY, LAYERS, { seed: 5, egg })
    r.place(0, 0)
    const t = x === null ? [...r.tiles.values()].find((t) => t.n === 2).site : { x, z }
    r.update(t.x, GROUND + 1.7, t.z)
    return r
  }
  const r = grow()
  const tile = [...r.tiles.values()].find((t) => t.n === 2 && !r.rim.isHidden(t.ids[1]))
  const first = [...r.tiles.values()].find((t) => t.n === 2).site
  const at = { x: first.x, z: first.z }
  const id = tile.ids[1]
  const eggsWere = r.stats.eggs, placedWere = r.stats.placed, usedWere = r.stats.used
  const hit = r.pickAt(r.instX[id], r.instY[id], r.instZ[id], 0.1, 2)
  check(hit !== null && hit.tile === tile && hit.id === id && hit.dist === 0 && hit.size === r.instR[id], 'pickAt at an egg\'s centre hits it, its size its height', hit ? `${fmt(hit.size)} m` : 'null')
  check(r.pickAt(r.instX[id], r.instY[id] + 5, r.instZ[id], 0.1, 2) === null, 'and nothing five metres above it')
  check(r.pickAt(r.instX[id], r.instY[id], r.instZ[id], 0.1, r.instR[id]) === null, 'nor one at or over maxSize')
  check(r.pickAt(tile.site.x, tile.site.y, tile.site.z, 0.1, 100)?.id !== tile.ids[0], 'the roost itself is never offered')
  const c = r.batch.getColorAt(id, new THREE.Color()).getHex()
  const rec = r.take(hit, 1)
  check(rec.kind === 'egg' && rec.name === 'dragon egg' && rec.size === hit.size && rec.geometry === egg.geometry && rec.material === r.eggMaterial && rec.stowable === true, 'take: a stowable dragon egg on the pick\'s geometry and the shell\'s material')
  check(Math.abs(rec.scale[0] - rec.size / egg.bounds.height) < 1e-6 && rec.scale[1] === rec.scale[0] && rec.scale[2] === rec.scale[0] && new THREE.Color().setRGB(...rec.color).getHex() === c, 'scaled by its height over the pick, in its clutch tint', JSON.stringify(rec.scale))
  check(tile.n === 1 && r.stats.eggs === eggsWere - 1 && r.stats.placed === placedWere && r.stats.used === usedWere - 1 && !r.batch.getVisibleAt(id) && r.tierAt[id] === -1, 'the nest stands with no egg, the instance back in the pool', `${r.stats.eggs} eggs, ${r.stats.used} used`)
  check(taken.has('egg', tile.site.x, tile.site.z), 'the nest is recorded')
  check(r.pickAt(r.instX[id], r.instY[id], r.instZ[id], 0.1, 2)?.id !== id, 'and the egg cannot be taken twice')
  const d = r.dress({ kind: 'egg' })
  check(d.geometry === egg.geometry && d.material === r.eggMaterial, 'dress: the pick\'s geometry and the shell\'s material')
  let threw = false
  try { r.dress({ kind: 'fern' }) } catch { threw = true }
  check(threw, 'dress throws on another kind')
  const bare = roostsOn(flatField(GROUND), DRY, LAYERS, 5)
  check(bare.dress({ kind: 'egg' }) === null && bare.pickAt(0, GROUND, 0, 1000, 2) === null, 'a world with no eggs dresses none and offers none')
  bare.dispose()
  const again = grow(at.x, at.z)
  const same = [...again.tiles.values()].find((t) => t.tx === tile.tx && t.tz === tile.tz)
  check(same.n === 1 && again.stats.eggs === eggsWere - 1 && again.stats.placed === placedWere, 'grown again the nest lays no other egg and the rest are as they were', `${again.stats.eggs} eggs`)
  again.dispose()
  taken.clear()
  const whole = grow(at.x, at.z)
  check(whole.stats.eggs === eggsWere, 'and with the registry cleared the egg is back')
  // A peer's take: the egg evicted by its nest's site, hidden or shown; a nest without one, a foreign key and an empty spot are false.
  const te = [...whole.tiles.values()].find((t) => t.n === 2 && whole.rim.isHidden(t.ids[1])) ?? [...whole.tiles.values()].find((t) => t.n === 2)
  check(whole.evict('skull', te.site.x, te.site.z) === false && whole.evict('egg', te.site.x + 5, te.site.z) === false && whole.stats.eggs === eggsWere, 'evict is false for a foreign key or an empty spot')
  check(whole.evict('egg', te.site.x + 0.03, te.site.z - 0.03) === true && te.n === 1 && whole.stats.eggs === eggsWere - 1 && taken.has('egg', te.site.x, te.site.z), `evict lifts the egg a peer took, ${whole.rim.isHidden(te.ids[0]) ? 'rim-hidden' : 'shown'}, and records the nest`)
  check(whole.evict('egg', te.site.x, te.site.z) === false, 'and is false for the nest once emptied')
  whole.dispose()
  r.update(tile.site.x + 4000, GROUND + 1.7, tile.site.z)
  check(r.stats.used === r.stats.placed + r.stats.eggs, 'walked off, the nest releases cleanly without its egg')
  r.dispose()
  // A second world: an egg taken with stowMax at its height comes up in the hand but will not go in the backpack.
  const w = grow()
  const t2 = [...w.tiles.values()].find((t) => t.n === 2 && !w.rim.isHidden(t.ids[1]))
  const h2 = w.pickAt(w.instX[t2.ids[1]], w.instY[t2.ids[1]], w.instZ[t2.ids[1]], 0.1, 2)
  check(h2 && w.take(h2, h2.size).stowable === false, 'one at or over stowMax is not stowable')
  w.dispose()
  taken.clear()
}

// --- a stand-in dragon: a slab on a spine whose fly swings its wings out, its underside on two feet ------------
function makeAsset() {
  const root = new THREE.Bone(); root.name = 'Root'
  const spine = new THREE.Bone(); spine.name = 'Spine'; spine.position.set(0.2, 0.1, 0)
  const { span, width, height } = wyvern
  // Each leg a three-joint chain off the spine, as the foot IK wants: Leg, then Foot at the underside.
  const legBones = ['Left', 'Right'].map((side, i) => {
    const leg = new THREE.Bone(); leg.name = `${side}Leg`; leg.position.set(0, -0.05, (i ? -1 : 1) * width / 4)
    const foot = new THREE.Bone(); foot.name = `${side}Foot`; foot.position.set(0, -0.05, 0)
    leg.add(foot); spine.add(leg)
    return [leg, foot]
  })
  root.add(spine); root.updateMatrixWorld(true)
  const bones = [root, spine, legBones[0][1], legBones[1][1], legBones[0][0], legBones[1][0]]
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  const tiers = Array.from({ length: LOD_RUNGS }, (_, k) => {
    const g = new THREE.BoxGeometry(span, height, width, LOD_RUNGS - k, 1, 1).translate(0, height / 2, 0)
    const pos = g.getAttribute('position')
    const n = pos.count
    // Every vertex on the slab's underside belongs to the foot on its side; the rest to the spine.
    const joint = (v) => (Math.abs(pos.getY(v)) < 1e-6 ? (pos.getZ(v) > 0 ? 2 : 3) : 1)
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2))
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4).map((_, i) => (i % 4 === 0 ? joint(i >> 2) : 0)), 4))
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
  const legs = [{ id: 'hindLeft', chain: ['Spine', 'LeftLeg', 'LeftFoot'] }, { id: 'hindRight', chain: ['Spine', 'RightLeg', 'RightFoot'] }]
  return { root, skeleton, tiers, clips, map: null, sizeM: wyvern.sizeM, span, width, height, gait: { ...wyvern.gait }, legs }
}

/** A stand-in herd: `stags` the slots a dragon may find, seize, carry and drop, every call counted on the slot. */
function makeHerd(stags) {
  return {
    stags,
    prey(x, z, range) {
      this.preyCalls++
      let best = null, bestD = range
      for (const s of stags) {
        if (!s.spawn) continue
        const d = Math.hypot(s.x - x, s.z - z)
        if (d < bestD) { best = s; bestD = d }
      }
      return best
    },
    preyCalls: 0,
    seize(c) { c.spawn = null; c.act = 'dead'; c.seized++; return c },
    carry(c, m, dist, dt, lain = false, shown) {
      c.carried++
      c.lain = lain
      c.shown = shown
      if (shown) c.shownFrames++
      if (lain) c.lainFrames++
      c.at.setFromMatrixPosition(m)
      c.up.set(0, 1, 0).transformDirection(m)
      c.x = c.at.x; c.y = c.at.y; c.z = c.at.z
      c.carryDist = dist; c.carryDt = dt
    },
    drop(c, fade = true) { c.drops.push(fade) },
  }
}
const stag = (x, z, y = GROUND) => ({ spawn: {}, x, y, z, k: 0.5, size: 2, lod: 0, seized: 0, carried: 0, lain: null, lainFrames: 0, shown: null, shownFrames: 0, drops: [], at: new THREE.Vector3(), up: new THREE.Vector3() })
const roostOf = (sites) => ({ sites: (into = []) => { into.push(...sites); return into } })
const dry = { isSubmerged: () => false }
const dragonsOn = (field, sites, herd, seed = 3, water = dry) => new Dragons(new THREE.Scene(), field, { seed, roosts: roostOf(sites), wildlife: herd, water, asset: makeAsset() })
const DT = 1 / 60
const HER = { x: 5, y: GROUND + 1.6, z: 5 }

// --- construction ----------------------------------------------------------------------
console.log('\ndragons')
{
  const flat = flatField(GROUND)
  check((() => { try { new Dragons(new THREE.Scene(), flat, { roosts: roostOf([]), wildlife: {}, asset: makeAsset() }); return false } catch (e) { return /prey, seize, carry and drop/.test(e.message) } })(), 'a wildlife without the prey hooks is refused by name')
  check((() => { try { new Dragons(new THREE.Scene(), flat, { roosts: {}, wildlife: makeHerd([]), asset: makeAsset() }); return false } catch (e) { return /sites/.test(e.message) } })(), 'so is a roost layer with no sites()')
  check((() => { try { new Dragons(new THREE.Scene(), flat, { roosts: roostOf([]), wildlife: makeHerd([]), asset: makeAsset() }); return false } catch (e) { return /isSubmerged/.test(e.message) } })(), 'and a world with no water to ask, since a dragon must not alight in a lake')

  const d = dragonsOn(flat, [], makeHerd([]))
  const fly = measureFly(makeAsset())
  check(fly.halfX > 0 && fly.halfZ > 0 && fly.maxY > fly.minY && fly.halfZ * 2 > wyvern.width && fly.halfX * 2 > wyvern.span, 'the fly pose is measured on the CPU, and it reaches wider than the standing body every way', `half ${fmt(fly.halfX)} x ${fmt(fly.halfZ)}, y ${fmt(fly.minY)} to ${fmt(fly.maxY)}, widest at ${fmt(fly.spreadAt)} s`)
  check(fly.spreadAt > 0 && fly.spreadAt < 0.9, 'and the photograph is taken at the frame the wings reach widest, not the folded first one')
  check(Number.isFinite(fly.talons.x + fly.talons.y + fly.talons.z) && Math.abs(fly.talons.y - fly.minY) < 1e-6, 'the talons are the mean of the feet\'s vertices over the fly, here the slab\'s underside', `(${fmt(fly.talons.x)}, ${fmt(fly.talons.y)}, ${fmt(fly.talons.z)})`)
  check((() => { try { measureFly({ ...makeAsset(), legs: [] }); return false } catch (e) { return /talons/.test(e.message) } })(), 'an asset naming no legs is refused: nothing to hang a kill from')
  check(d.bulk > 1 && Math.abs(d.bulk - Math.max(2 * fly.halfX, 2 * fly.halfZ, fly.maxY - fly.minY) / wyvern.span) < 1e-9, 'the ladder is sized by the flying body\'s largest extent over the shipped span, and so reaches farther than the standing body would', `bulk ${d.bulk.toFixed(3)}`)
  check(d.materials.length === 2 * PUPPETS + 2 && d.materials[0] === d.plain && d.materials[d.materials.length - 1] === d.cardMaterial, 'one settled material, a dissolving pair a puppet, and the card, all offered to the lighting', `${d.materials.length}`)
  check(d.plain.customProgramCacheKey() === 'dragons' && d.puppetMats.every((m) => m.plain === d.plain && m.in.customProgramCacheKey() === 'dragons-fade'), 'every puppet draws its settled tiers through THE ONE material and dissolves through the one fade program')
  // The gleam: settled and fading alike a Standard at SCALE_ROUGHNESS, no metalness, the lobe scaled by GLINT; the card stays a photograph.
  const body = [d.plain, ...d.puppetMats.flatMap((m) => [m.in, m.out])]
  check(body.every((m) => m.isMeshStandardMaterial && m.roughness === SCALE_ROUGHNESS && m.metalness === 0) && SCALE_ROUGHNESS > 0 && SCALE_ROUGHNESS < 1 && !d.cardMaterial.isMeshStandardMaterial, 'the body is a Standard material at SCALE_ROUGHNESS, settled or dissolving, and the card is not', `${d.plain.type} roughness ${d.plain.roughness}`)
  {
    const compile = (m) => { const sh = { uniforms: {}, vertexShader: '#include <common>\n', fragmentShader: '#include <common>\n#include <clipping_planes_fragment>\n#include <lights_fragment_end>\n' }; m.onBeforeCompile(sh); return sh.fragmentShader }
    const settled = compile(d.plain), fading = compile(d.puppetMats[0].in)
    check(settled.includes(`reflectedLight.directSpecular *= ${GLINT.toFixed(2)};`) && fading.includes(`reflectedLight.directSpecular *= ${GLINT.toFixed(2)};`) && fading.includes('uCut') && !settled.includes('uCut'), 'the glint is spliced into the settled program and the fade program, which keeps its cut')
  }
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
  const site = { key: 1234, x: 0, y: GROUND, z: 0, r: 4, gx: 0, gz: 0 }
  const stags = [stag(120, 60)]
  const herd = makeHerd(stags)
  const d = dragonsOn(flat, [site], herd)

  d.update(HER.x, HER.y, HER.z, DT)
  const dr = d.byKey.get(site.key)
  check(dr && d.byKey.size === 1 && d.free.length === MAX - 1 && dr.site === site, 'the frame a site is listed a dragon is born to it, keyed by the roost\'s tile')
  check(dr.state === 'roost' && Math.abs(dr.x - site.x) < 1e-9 && Math.abs(dr.z - site.z) < 1e-9 && dr.y > site.y && dr.y < site.y + 0.1 * site.r && dr.clip === 'idle', 'born on its nest, standing a hand over the floor, idling', `y ${fmt(dr.y)} over ${fmt(site.y)}`)
  check(Math.abs(dr.size / wyvern.sizeM - 1) <= SIZE_VARY && Math.abs(dr.k - dr.size / wyvern.span) < 1e-12 && Math.abs(dr.lodSize - dr.size * d.bulk) < 1e-12, `sized within ${SIZE_VARY * 100}% of the roster, the ladder sized by the flying bulk`, `${fmt(dr.size)} m, lod size ${fmt(dr.lodSize)}`)
  check(dr.timer >= FIRST_S[0] && dr.timer <= FIRST_S[1] && dr.lod === 0 && dr.puppet, `born rested, off within ${FIRST_S[0]} to ${FIRST_S[1]} s, and wearing a puppet with her beside the nest`, `rest left ${fmt(dr.timer)} s`)
  const born = { size: dr.size, heading: dr.heading }
  const twin = dragonsOn(flat, [site], makeHerd([]), 3)
  twin.update(HER.x, HER.y, HER.z, DT)
  check(twin.byKey.get(site.key).size === born.size && twin.byKey.get(site.key).heading === born.heading, 'the same nest holds the same dragon every visit: its size and its first heading are the roost\'s seed')
  twin.dispose()

  check(dr.fedAt <= 0 && dr.fedAt > -HUNGER_S, 'born some way into its hunger, so a valley of roosts does not all hunt at once', `fed ${fmt(-dr.fedAt)} s ago`)
  // Hungry by hand, so this first flight is the hunt.
  dr.fedAt = -Infinity

  // Fly the loop, measuring every frame against the rates.
  const trace = []
  const seen = new Set(['roost'])
  // Every frame measured against the rates, in every state: a landing that snaps level or onto its stand point is a pop on a nest she may be standing beside.
  const worst = { turn: 0, pitch: 0, roll: 0, speed: 0, accel: 0, move: 0, under: Infinity, farFromHome: 0, banked: 0 }
  const AIRBORNE = new Set(['patrol', 'explore', 'visit', 'hunt', 'strike', 'return'])
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
  check(trace.join(' ').replace(/@[\d.]+s/g, '') === 'patrol hunt strike return land', 'hungry, it flies the hunt in order: patrol, hunt, strike, return, land, and is home again', trace.join(' '))
  check(homeAt > 0 && homeAt < 400, 'and the whole flight, with a stag 130 m off, takes under seven minutes', `${fmt(homeAt)} s`)
  check(tookOff > 0 && tookOff <= FIRST_S[1] && dr.clip === 'walk' && dr.rest === 'walk', 'off the nest when its first rest ran out, and back on it walking a circuit before it eats', `took off at ${fmt(tookOff)} s`)
  check(stags[0].seized === 1 && stags[0].spawn === null && stags[0].act === 'dead' && dr.cargo === stags[0] && d.stats.carrying === 1, 'the stag was seized ONCE -- its spawn dead, its slot the dragon\'s cargo -- and is still the cargo on the nest')
  check(worst.speed <= DIVE_MPS + 1e-6 && worst.speed > HUNT_MPS, 'the dive was the fastest it flew, faster than the hunt and no faster than the dive allows', `${fmt(worst.speed)} m/s`)
  check(worst.under > 0.1 && worst.under < 1.001, 'never once in the air was the body under its nest floor, and it climbed off the nest rather than being lifted to its metre of clearance', `lowest ${fmt(worst.under)} m over the ground`)
  check(worst.farFromHome < PATROL_M + 100, `and never strayed much past ${PATROL_M} m from the nest`, `${fmt(worst.farFromHome)} m at most`)
  check(d.stats.forced === 0, 'the landing was flown, not forced by the clock', `forced ${d.stats.forced}`)
  const landed = { x: dr.x, y: dr.y, z: dr.z, pitch: dr.pitch }
  const kill = { x: stags[0].x, z: stags[0].z }

  // The meal: a circuit of the nest, round behind the kill, up to it, and the eating; the carcass never moves until it is eaten.
  const walkMps = wyvern.gait.walk * dr.k
  const nest = { moved: 0, walkFast: 0, offFloor: 0, killMoved: 0, farthest: 0, headings: 0, eatAt: -1, ateAt: -1, eatFacing: Infinity, eatFrom: Infinity, clips: new Set() }
  let lastHeading = dr.heading
  for (let i = 0; i < 60 * 240 && nest.ateAt < 0; i++) {
    d.update(HER.x, HER.y, HER.z, DT)
    nest.moved += Math.hypot(dr.x - prev.x, dr.z - prev.z)
    measure()
    if (dr.cargo) cargoFrames++
    nest.clips.add(dr.clip)
    // Three seconds in, the landing's speed has bled off and the body is on the floor: from here every frame is a walk or a stand.
    if (i > 60 * 3) {
      if (dr.speed > walkMps * 1.001) nest.walkFast++
      if (Math.abs(dr.y - (site.y + 0.04 * site.r)) > 1e-6) nest.offFloor++
      if (dr.state !== 'roost') throw new Error(`left the nest mid-meal: ${dr.state}`)
    }
    nest.headings += Math.abs(swing(lastHeading, dr.heading)); lastHeading = dr.heading
    nest.farthest = Math.max(nest.farthest, Math.hypot(dr.x - site.x, dr.z - site.z))
    if (dr.cargo && (Math.abs(stags[0].x - kill.x) > 1e-9 || Math.abs(stags[0].z - kill.z) > 1e-9)) nest.killMoved++
    if (dr.rest === 'eat' && nest.eatAt < 0) nest.eatAt = i * DT
    if (dr.rest === 'eat') {
      nest.eatFacing = Math.min(nest.eatFacing, Math.abs(swing(dr.heading, Math.atan2(-(kill.z - dr.z), kill.x - dr.x))))
      nest.eatFrom = Math.hypot(kill.x - dr.x, kill.z - dr.z)
    }
    if (!dr.cargo && nest.ateAt < 0) nest.ateAt = i * DT
  }
  check(Math.hypot(landed.x - site.x, landed.z - site.z) > 0.01 && nest.eatAt > 5 && nest.eatAt < 120, 'the landing hands over short of the stand point and the dragon walks a circuit of the nest before it eats', `landed ${fmt(Math.hypot(landed.x - site.x, landed.z - site.z))} m out, eating from ${fmt(nest.eatAt)} s`)
  check(nest.moved > 2 * site.r && nest.headings > Math.PI && nest.farthest < site.r, 'the circuit walked more than two radii and turned more than a half turn, all of it inside the rim', `${fmt(nest.moved)} m, ${fmt(nest.headings)} rad, ${fmt(nest.farthest)} m out at most`)
  check(nest.walkFast === 0 && nest.offFloor === 0, 'and once down, never moved faster than the shipped walk gait at its size nor left the floor plane', `walk ${fmt(walkMps)} m/s; ${nest.walkFast} fast frames, ${nest.offFloor} off the floor`)
  check(nest.killMoved === 0 && Math.hypot(kill.x - site.x, kill.z - site.z) < site.r && Math.hypot(kill.x - site.x, kill.z - site.z) > 0.5 && Math.abs(stags[0].y - site.y) < 1e-6, 'the kill lay where it was dropped, on the nest floor off centre, through the whole circuit: it does not follow the dragon round', `at (${fmt(kill.x)}, ${fmt(kill.z)}), nest r ${site.r}`)
  check(nest.eatFacing < 0.1 && Math.abs(nest.eatFrom - EAT_REACH * dr.k) < WAY_M, `eating, it faces the kill with the kill ${fmt(EAT_REACH * dr.k)} m ahead, where the eat clip's snout plunges`, `off by ${fmt(nest.eatFacing)} rad, ${fmt(nest.eatFrom)} m`)
  check(nest.ateAt > 0 && nest.ateAt - nest.eatAt >= EAT_S[0] - 0.1 && nest.ateAt - nest.eatAt <= EAT_S[1] + 0.1 && stags[0].drops.join() === 'true' && dr.cargo === null && d.stats.carrying === 0, `after ${EAT_S[0]} to ${EAT_S[1]} s of eating the carcass is gone -- dropped to fade -- and the dragon carries nothing`, `ate for ${fmt(nest.ateAt - nest.eatAt)} s`)
  check(Math.abs(dr.age - dr.fedAt) < 1e-9 && !d._hungry(dr), 'and the meal is when it last ate: it is not hungry now')
  check(stags[0].carried === cargoFrames && cargoFrames > 60 && stags[0].carryDt === DT, 'wildlife.carry was called on every frame it was cargo, with the frame', `${cargoFrames} frames`)
  check(stags[0].shownFrames === cargoFrames, 'and told the dragon was drawn on every one of them: she stood beside the nest the whole hunt', `${stags[0].shownFrames} of ${cargoFrames}`)
  check(stags[0].lain === true && stags[0].lainFrames > 60 * 5 && stags[0].lainFrames < cargoFrames, 'hanging from the talons through the whole flight and laid on its flank from the frame it landed to the frame it was eaten', `lain ${stags[0].lainFrames} of ${cargoFrames} cargo frames`)
  check(worst.turn <= LAND_TURN_RATE + 1e-6 && worst.pitch <= PITCH_RATE + 1e-6 && worst.roll <= ROLL_RATE + 1e-6 && worst.accel <= ACCEL + 1e-6 && worst.move <= DIVE_MPS * 1.001, 'and no frame of it, landing, walking and eating included, turned, pitched, banked, accelerated or moved the body faster than its rates', `turn ${fmt(worst.turn)}/${LAND_TURN_RATE} pitch ${fmt(worst.pitch)}/${PITCH_RATE} roll ${fmt(worst.roll)}/${ROLL_RATE} accel ${fmt(worst.accel)}/${ACCEL} move ${fmt(worst.move)}/${DIVE_MPS}`)
  check(worst.banked > 0.3 && worst.banked <= BANK + 1e-9, `it banked into its turns, never past ${BANK} rad`, `${fmt(worst.banked)} rad at most`)
  check(seizedAt > 0 && Math.abs(dr.roll) < 1e-9 && Math.abs(dr.pitch) < 1e-9, 'standing level')

  // Fed, it potters for the rest: several kinds of step, walks among them, and no takeoff before the rest's least.
  const potter = { clips: new Set(), walked: 0, tookOff: -1 }
  for (let i = 0; i < 60 * (REST_S[1] + 5) && potter.tookOff < 0; i++) {
    d.update(HER.x, HER.y, HER.z, DT)
    if (dr.state === 'roost') { potter.clips.add(dr.clip); if (dr.rest === 'walk') potter.walked += DT }
    else potter.tookOff = i * DT
  }
  check(potter.tookOff >= REST_S[0] - 1 && potter.tookOff <= REST_S[1] + 1, `fed, it stays on the nest for the rest, ${REST_S[0]} to ${REST_S[1]} s`, `${fmt(potter.tookOff)} s`)
  check(potter.clips.size >= 3 && potter.walked > 5 && !potter.clips.has('eat') && !potter.clips.has('fly'), 'and does not just stand there: three kinds of step at least, walking among them, and no eating with nothing to eat', [...potter.clips].join(' ') + `, walked ${fmt(potter.walked)} s`)
  check(dr.state === 'explore' && dr.cargo === null && herd.preyCalls > 0, `fed within ${HUNGER_S} s, its next flight is to explore, not to hunt`)
  check(herd.prey(dr.x, dr.z, HUNT_M) === null, 'a seized stag is not prey again')
  const preyCallsBefore = herd.preyCalls

  // The explore: no stag is looked for, the cruise meanders, and hunger in the air turns it to a patrol.
  let pitchFlips = 0, rollFlips = 0, swung = 0, netted = 0, patrolLow = Infinity, patrolHigh = 0
  let lastPitch = 0, lastRoll = 0
  lastHeading = dr.heading
  for (let i = 0; i < 60 * 40; i++) {
    d.update(HER.x, HER.y, HER.z, DT)
    if (dr.state === 'explore' && i > 60 * 20) {
      patrolLow = Math.min(patrolLow, dr.y - GROUND); patrolHigh = Math.max(patrolHigh, dr.y - GROUND)
      if (dr.pitch * lastPitch < 0) pitchFlips++
      if (dr.roll * lastRoll < 0) rollFlips++
      swung += Math.abs(swing(lastHeading, dr.heading)); netted += swing(lastHeading, dr.heading)
    }
    lastPitch = dr.pitch; lastRoll = dr.roll; lastHeading = dr.heading
  }
  check(herd.preyCalls === preyCallsBefore && ['explore', 'visit', 'land', 'perch'].includes(dr.state), 'forty seconds of exploring asked the wildlife for no stag at all', dr.state)
  check(patrolLow >= MIN_AGL - 5 && patrolHigh > MIN_AGL, `once up, the cruise kept about ${MIN_AGL} m over the ground or higher`, `${fmt(patrolLow)} to ${fmt(patrolHigh)} m`)
  check(pitchFlips >= 2 && rollFlips >= 2 && swung > 2 * Math.abs(netted) + 1, 'and it swooped and careened the whole way: pitch and roll crossed level again and again and the heading swung far more than it netted', `pitch flips ${pitchFlips}, roll flips ${rollFlips}, swung ${fmt(swung)} rad for ${fmt(netted)} net`)
  if (dr.state !== 'explore') { dr.state = 'explore'; dr.dest = site }
  dr.fedAt = -Infinity
  d.update(HER.x, HER.y, HER.z, DT)
  check(dr.state === 'patrol', 'an explorer that goes hungry in the air turns to patrolling where it is')
  // Empty patrol: with the only stag eaten, the flight clock sends it home.
  let home = -1
  for (let i = 0; i < 60 * (FLIGHT_S[1] + 200) && home < 0; i++) {
    d.update(HER.x, HER.y, HER.z, DT)
    if (dr.state === 'roost') home = i * DT
  }
  check(home > 0 && home < FLIGHT_S[1] + 150 && !dr.cargo && herd.preyCalls > preyCallsBefore, `with nothing to hunt the patrol turns for home when its clock runs out and lands within ${FLIGHT_S[1]} s and the flight back`, `${fmt(home)} s`)
  d.dispose()
}

// --- exploring: a sated dragon visits a spot away from the nest, perches and potters there, and flies on; steep or drowned ground it does not ---
{
  const flat = flatField(GROUND)
  const site = { key: 4321, x: 0, y: GROUND, z: 0, r: 4, gx: 0, gz: 0 }
  const herd = makeHerd([stag(150, 0)])
  const d = dragonsOn(flat, [site], herd, 8)
  d.update(HER.x, HER.y, HER.z, DT)
  const dr = d.byKey.get(site.key)
  dr.fedAt = dr.age
  dr.timer = 0.5
  const visit = { at: -1, flights: 0, state: '' }
  let was = dr.state
  for (let i = 0; i < 60 * 3 * (FLIGHT_S[1] + REST_S[1] + 400) && visit.at < 0; i++) {
    d.update(HER.x, HER.y, HER.z, DT)
    dr.fedAt = dr.age
    if (dr.state === 'explore' && was === 'roost') visit.flights++
    if (dr.state === 'perch') visit.at = i * DT
    was = dr.state
  }
  check(visit.at > 0 && visit.flights <= 3 && herd.preyCalls === 0, 'kept fed, within three flights it alights on a spot away from the nest, and never once looked for a stag', `perched at ${fmt(visit.at)} s on flight ${visit.flights}`)
  const spot = dr.dest
  check(spot !== site && spot.turf === true && Math.hypot(spot.x - site.x, spot.z - site.z) >= SPOT_AWAY * site.r && Math.hypot(spot.x - site.x, spot.z - site.z) <= PATROL_M + 20, `the spot is turf ${SPOT_AWAY} nest radii or more from home and within the patrol's range`, `${fmt(Math.hypot(spot.x - site.x, spot.z - site.z))} m from the nest`)
  const perch = { clips: new Set(), walked: 0, offGround: 0, off: 0, y: 0 }
  for (let i = 0; i < 60 * (PERCH_S[1] + 5) && dr.state === 'perch'; i++) {
    d.update(HER.x, HER.y, HER.z, DT)
    dr.fedAt = dr.age
    if (dr.state === 'perch') perch.clips.add(dr.clip)
    if (dr.rest === 'walk') perch.walked += DT
    if (i > 60 * 3 && Math.abs(dr.y - GROUND) > 1e-6) perch.offGround++
    perch.off = Math.max(perch.off, Math.hypot(dr.x - spot.x, dr.z - spot.z))
  }
  check(perch.clips.size >= 2 && perch.walked > 2 && perch.offGround === 0 && perch.off < site.r, 'perched, it potters as at home -- walking about, standing on the ground itself -- and stays about the spot', `${[...perch.clips].join(' ')}, walked ${fmt(perch.walked)} s, ${fmt(perch.off)} m out at most`)
  check(['explore', 'return'].includes(dr.state) && dr.clip === 'fly' && dr.dest === site, `and after ${PERCH_S[0]} to ${PERCH_S[1]} s it flies on, or home if the flight's clock ran out perched`, dr.state)
  d.dispose()

  const never = (label, field, water = dry) => {
    const dd = dragonsOn(field, [site], makeHerd([]), 8, water)
    dd.update(HER.x, HER.y, HER.z, DT)
    const b = dd.byKey.get(site.key)
    b.timer = 0.5
    let perched = false
    for (let i = 0; i < 60 * 3 * (FLIGHT_S[1] + REST_S[1] + 400) && !perched; i++) { dd.update(HER.x, HER.y, HER.z, DT); b.fedAt = b.age; if (b.state === 'perch' || b.state === 'visit') perched = true }
    check(!perched, label)
    dd.dispose()
  }
  never('with every spot under water, three flights alight nowhere but the nest', flat, { isSubmerged: () => true })
  never(`nor on ground steeper than ${SPOT_SLOPE_DEG} degrees`, flatField(GROUND, Math.tan((SPOT_SLOPE_DEG + 5) * Math.PI / 180)))
}

// --- a nest on a hillside: the dragon stands on its floor and the kill lies on its plane ----
{
  const gx = 0.25, gz = -0.15
  const hill = hillField(GROUND, gx, gz)
  const site = { key: 31, x: 40, y: hill.heightAt(40, -20) - 0.06 * 4, z: -20, r: 4, gx, gz }
  const stags = [stag(500, 500)]
  const d = dragonsOn(hill, [site], makeHerd(stags))
  d.update(HER.x, HER.y, HER.z, DT)
  const dr = d.byKey.get(site.key)
  check(Math.abs(dr.y - (site.y + 0.04 * site.r)) < 1e-9 && dr.y > hill.heightAt(site.x, site.z) - 0.1, 'born standing a hand over the floor at the bowl\'s centre, which is at the turf, not under the uphill half of the hill')
  // The kill laid on this nest, by hand: landed with it.
  dr.cargo = stags[0]
  d._perch(dr)
  d.update(HER.x, HER.y, HER.z, DT)
  const c = stags[0]
  const u = c.x - site.x, v = c.z - site.z
  const normal = new THREE.Vector3(-gx, 1, -gz).normalize()
  check(c.lain === true && Math.hypot(u, v) > 0.5 && Math.hypot(u, v) < site.r && Math.abs(c.y - (site.y + gx * u + gz * v)) < 1e-9, 'a kill on this nest lies beside the dragon ON the tilted floor plane, at that plane\'s own height there, not at the centre\'s', `at (${fmt(u)}, ${fmt(v)}) off centre, y ${fmt(c.y)} for a floor of ${fmt(site.y + gx * u + gz * v)}`)
  check(c.up.distanceTo(normal) < 1e-9, 'and lies tilted with the floor, its up the nest plane\'s normal', `up (${fmt(c.up.x)}, ${fmt(c.up.y)}, ${fmt(c.up.z)})`)
  check((() => { try { dragonsOn(hill, [{ key: 32, x: 0, y: GROUND, z: 0, r: 4 }], makeHerd([])).update(0, 0, 0, DT); return false } catch (e) { return /floor plane/.test(e.message) } })(), 'a site with no floor plane is refused by name, not stood on at NaN')
  d.dispose()
}

// --- a fish in her hand: a roosting dragon drops its kill and comes off the nest at her ----
{
  const flat = flatField(GROUND)
  const site = { key: 78, x: 0, y: GROUND, z: 0, r: 4, gx: 0, gz: 0 }
  const stags = [stag(500, 500)]
  const d = dragonsOn(flat, [site], makeHerd(stags), 5)
  // She stands east of the nest, the hand a metre up, and never moves her feet: the hand is what the dragon reads.
  const her = { x: 12, y: GROUND + 1.6, z: 0 }
  const hand = (kind, x, z = 0) => ({ kind, x, y: GROUND + 1, z })
  let turned = 0
  const run = (s, lures, seen) => { for (let i = 0; i < s * 60; i++) { const h0 = dr.heading; d.update(her.x, her.y, her.z, DT, lures); turned = Math.max(turned, Math.abs(swing(h0, dr.heading)) / DT); if (seen) seen() } }
  d.update(her.x, her.y, her.z, DT)
  const dr = d.byKey.get(site.key)
  dr.timer = Infinity
  const reach = EAT_REACH * dr.k + MENACE_M
  const gap = (l) => Math.hypot(l.x - dr.x, l.z - dr.z)
  // Out of reach, or the wrong thing: the dragon rests on.
  run(2, [hand('fish', LURE_M + 1)])
  check(dr.state === 'roost' && dr.lure === null, `a fish ${LURE_M + 1} m off is not noticed`)
  run(2, [hand('carrot', 2)])
  check(dr.state === 'roost' && dr.lure === null, 'nor is a carrot in reach', LURES.join(', '))
  // Eating its kill on the nest when the fish comes within reach: the kill is let go, and the dragon is up and alert.
  dr.cargo = stags[0]
  d._perch(dr)
  run(1, [])
  check(dr.state === 'roost' && dr.cargo === stags[0] && dr.queue.length > 0, 'settled on the nest with its kill, working through its circuit')
  const fish = hand('fish', LURE_M - 0.5)
  d.update(her.x, her.y, her.z, DT, [fish])
  check(dr.state === 'menace' && dr.lure === fish && dr.cargo === null && stags[0].drops.join() === 'true' && dr.clip === 'alert' && dr.queue.length === 0 && dr.timer === Infinity, `a fish ${LURE_M - 0.5} m off has it drop the kill to fade and go to menace, alert`, `state ${dr.state}, clip ${dr.clip}, drops ${stags[0].drops.join()}`)
  // The stomp: at the walk gait inside MENACE_RUN_M, toward the hand, and stopped with its head at her, eating at her.
  turned = 0
  let walked = false
  let top = 0
  const x0 = dr.x
  run(6, [fish], () => { if (dr.clip === 'walk') walked = true; top = Math.max(top, dr.speed) })
  check(walked && top > wyvern.gait.walk * dr.k * 0.9 && top <= wyvern.gait.walk * dr.k + 1e-9 && dr.x > x0 + 0.5, 'it walks at the hand at the walk gait', `top ${fmt(top)} of ${fmt(wyvern.gait.walk * dr.k)} m/s, ${fmt(dr.x - x0)} m east`)
  // The stop is a deceleration at ACCEL from the walk, so the stance is that stopping distance short of reach.
  const stops = (l) => gap(l) < reach + 0.05 && gap(l) > reach - (wyvern.gait.walk * dr.k) ** 2 / (2 * ACCEL) - 0.05
  const facing = (l) => Math.abs(swing(dr.heading, Math.atan2(-(l.z - dr.z), l.x - dr.x))) < 0.05
  check(dr.clip === 'eat' && dr.speed < 0.05 && stops(fish) && facing(fish), `and stops eating at her, its head EAT_REACH + MENACE_M ${fmt(reach)} m short of the hand, facing it`, `clip ${dr.clip}, ${fmt(gap(fish))} m off, heading ${fmt(dr.heading)}`)
  check(turned <= WALK_TURN_RATE + 1e-6, `never turning faster than WALK_TURN_RATE ${WALK_TURN_RATE}`, `${fmt(turned)} rad/s`)
  check(dr.y >= GROUND && dr.y < GROUND + 0.05 * site.r && Math.abs(dr.pitch) < 1e-6 && Math.abs(dr.roll) < 1e-6, 'level, standing over the nest floor still', `y ${fmt(dr.y)}`)
  // A step back holds it; MENACE_M back has it after her again; and off past MENACE_RUN_M it runs.
  run(2, [hand('fish', fish.x + MENACE_M * 0.5)])
  check(dr.clip === 'eat', `a half step back and it eats on`)
  const back = hand('fish', fish.x + MENACE_M + 0.3)
  run(0.2, [back])
  check(dr.clip === 'walk', `MENACE_M back and it is walking after her again`, dr.clip)
  run(3, [back])
  check(dr.clip === 'eat' && stops(back), 'to stop at her again', `${fmt(gap(back))} m off`)
  const far = hand('fish', dr.x + reach + MENACE_RUN_M + 2)
  let ran = false
  top = 0
  run(8, [far], () => { if (dr.clip === 'run') { ran = true; top = Math.max(top, dr.speed) } })
  check(ran && top > wyvern.gait.run * dr.k * 0.9 && dr.state === 'menace', `the hand ${MENACE_RUN_M + 2} m past its head, it runs at the run gait`, `top ${fmt(top)} of ${fmt(wyvern.gait.run * dr.k)} m/s`)
  check(dr.clip === 'eat' && stops(far) && Math.abs(dr.y - GROUND) < 1e-6, 'and is at her again, on the ground off the nest', `${fmt(gap(far))} m off, y ${fmt(dr.y)}`)
  // Carried off at her 1.45 m/s walk, faster than its own: it stomps after her in rushes, run and stop, never far off.
  const walk = hand('fish', far.x, 0)
  let worst = 0
  let rushes = 0
  let running = false
  run(20, [walk], () => { walk.z -= 1.45 * DT; worst = Math.max(worst, gap(walk)); if (dr.clip === 'run') { if (!running) rushes++; running = true } else running = false })
  check(worst < reach + MENACE_RUN_M + 1 && rushes >= 2 && rushes <= 5 && gap(walk) < reach + MENACE_RUN_M + 1, 'carried off at her walk it stomps after her in rushes, run and stop, never far off', `never more than ${fmt(worst)} m off, ${rushes} rushes in 20 s, ${fmt(gap(walk))} m at the end`)
  // Kept to LURE_FORGET_M, given up past it: home to the nest and the rest clock started over.
  d.update(her.x, her.y, her.z, DT, [hand('fish', dr.x + LURE_FORGET_M - 0.5, dr.z)])
  check(dr.state === 'menace', `a fish ${LURE_FORGET_M - 0.5} m off is still menaced`)
  d.update(her.x, her.y, her.z, DT, [hand('fish', dr.x + LURE_FORGET_M + 1, dr.z)])
  check(dr.state === 'return' && dr.lure === null && dr.clip === 'fly' && dr.dest === site, `and one ${LURE_FORGET_M + 1} m off is given up: it flies home`, `state ${dr.state}`)
  let frames = 0
  while (dr.state !== 'roost' && frames++ < 60 * 120) d.update(her.x, her.y, her.z, DT)
  check(dr.state === 'roost' && Math.hypot(dr.x - site.x, dr.z - site.z) < site.r && dr.timer >= REST_S[0] && dr.timer <= REST_S[1] && dr.cargo === null, 'and is on its nest again, resting', `${(frames / 60).toFixed(1)} s, rest ${fmt(dr.timer)} s`)
  // Put away in its face: given up at once, from the ground.
  dr.timer = Infinity
  const near = hand('fish', dr.x + reach, dr.z)
  run(3, [near])
  check(dr.state === 'menace' && dr.clip === 'eat', 'a fish put at its face on the nest is eaten at')
  d.update(her.x, her.y, her.z, DT, [])
  check(dr.state === 'return' && dr.lure === null, 'and put away, it is given up the same frame')
  d.dispose()
}

// --- a stag that leaves the world mid-hunt, and a relief edit under a carrying dragon --
{
  const flat = flatField(GROUND)
  const site = { key: 77, x: 0, y: GROUND, z: 0, r: 4, gx: 0, gz: 0 }
  const stags = [stag(150, 0)]
  const herd = makeHerd(stags)
  const d = dragonsOn(flat, [site], herd, 11)
  d.update(HER.x, HER.y, HER.z, DT)
  const dr = d.byKey.get(site.key)
  dr.fedAt = -Infinity
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
  const site = { key: 9, x: 0, y: GROUND, z: 0, r: 4, gx: 0, gz: 0 }
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
  // A kill in its talons for the rest of the walk out, to see what it is told about the dragon's own rung.
  const kill = stag(0, 0)
  dr.cargo = kill
  check(at(reach(LOD_RUNGS) * 0.9) === LOD_RUNGS && !dr.puppet && d.cardN === 1 && d.cardMesh.count === 1 && d.freePuppets.length === PUPPETS, `at ${(reach(LOD_RUNGS) * 0.9).toFixed(0)} m the puppet is given back and the two cards drawn instead`)
  check(kill.carried > 0 && kill.shown === true, 'and the kill it carries is told the dragon is drawn, so its card holds under the dragon\'s')
  d.cardMesh.getMatrixAt(0, m)
  m.decompose(p, q, s)
  const e = new THREE.Euler().setFromQuaternion(q, 'YZX')
  check(Math.abs(p.x - dr.x) < 1e-3 && Math.abs(p.y - dr.y) < 1e-3 && Math.abs(p.z - dr.z) < 1e-3 && Math.abs(s.x - dr.k) < 1e-6, 'the card instance stands where the dragon is, at its size')
  check(Math.abs(swing(e.y, dr.heading)) < 1e-6 && Math.abs(e.z - dr.pitch) < 1e-6 && Math.abs(e.x - dr.roll) < 1e-6, 'and carries its whole orientation -- heading, pitch AND roll -- since a fixed pair of quads is turned by its matrix and by nothing else', `yaw ${fmt(e.y)} pitch ${fmt(e.z)} roll ${fmt(e.x)}`)
  check(d.cardFade.array[0] === 1, 'settled: the whole card is drawn, no dither left', `fade ${d.cardFade.array[0]}`)
  // The card cadence: with the kill put down, the dragon is behaved on one frame in CARD_EVERY, by the time banked, and its card is drawn on every one where it last was.
  {
    const held = { cargo: dr.cargo, ages: [], cards: 0, slid: 0 }
    dr.cargo = null
    const eye = { x: site.x + reach(LOD_RUNGS) * 0.9, y: HER.y, z: site.z }
    const last = new THREE.Matrix4()
    for (let i = 0; i < CARD_EVERY; i++) d.update(eye.x, eye.y, eye.z, DT)
    for (let i = 0; i < CARD_EVERY * 12; i++) {
      const age = dr.age
      d.cardMesh.getMatrixAt(0, last)
      d.update(eye.x, eye.y, eye.z, DT)
      d.cardMesh.getMatrixAt(0, m)
      if (dr.age !== age) held.ages.push(dr.age - age)
      else if (!m.equals(last)) held.slid++
      if (d.cardN === 1) held.cards++
    }
    check(dr.lod === LOD_RUNGS && held.ages.length === 12 && held.ages.every((a) => Math.abs(a - CARD_EVERY * DT) < 1e-9) && held.cards === CARD_EVERY * 12 && held.slid === 0, `on the card rung it is stepped once in ${CARD_EVERY} frames by ${CARD_EVERY} frames' time, and its card is drawn on all of them, where it last was on the held ones`, `${held.ages.length} steps of ${held.ages.map((a) => fmt(a / DT)).join('/')} frames, ${held.cards} card frames, ${held.slid} held frames with the card moved`)
    dr.cargo = held.cargo
  }
  const before = { x: dr.x, z: dr.z, state: dr.state }
  check(at(reach(LOD_RUNGS) * 4) === CARD_RUNGS && d.cardN === 0 && d.cardMesh.count === 0 && !dr.puppet && d.byKey.size === 1, `four times the card's reach, it is drawn as nothing at all -- and is still alive`)
  check(kill.shown === false, 'and the kill is told so, and goes with it')
  dr.cargo = null
  for (let i = 0; i < 60 * 120; i++) d.update(site.x + reach(LOD_RUNGS) * 4, HER.y, site.z, DT)
  check(dr.state !== 'roost' || before.state !== dr.state || dr.x !== before.x || dr.z !== before.z || d.stats.states.roost === 1, 'and still simulated out of sight: two minutes on, it has been about its loop', `now ${dr.state} at (${fmt(dr.x)}, ${fmt(dr.z)})`)
  check(d.stats.alive === 1 && d.stats.lod.length === LOD_RUNGS && d.stats.cards === 0 && typeof d.stats.states === 'object' && d.stats.starved === 0 && d.stats.overflow === 0, 'the stats read alive, a row a mesh rung, the cards, the states and the counters', JSON.stringify(d.stats))
  d.dispose()
}

// --- a roost that goes, too many roosts, and too many in mesh range -------------------
{
  const flat = flatField(GROUND)
  const sites = [{ key: 1, x: 0, y: GROUND, z: 0, r: 4, gx: 0, gz: 0 }]
  const roosts = roostOf(sites)
  const d = new Dragons(new THREE.Scene(), flat, { seed: 2, roosts, wildlife: makeHerd([]), water: dry, asset: makeAsset() })
  d.update(HER.x, HER.y, HER.z, DT)
  const dr = d.byKey.get(1)
  check(dr && dr.puppet, 'a dragon with her beside its nest wears a puppet')
  sites.length = 0
  d.update(HER.x, HER.y, HER.z, DT)
  check(d.byKey.size === 0 && d.free.length === MAX && dr.site === null && d.fading.length === 1 && d.freePuppets.length === PUPPETS - 1, 'the frame its roost goes the dragon is retired and its body left to dissolve')
  for (let i = 0; i < 60 * 3; i++) d.update(HER.x, HER.y, HER.z, DT)
  check(d.fading.length === 0 && d.freePuppets.length === PUPPETS, 'and the puppet is back in the pool once the dissolve is done')

  for (let k = 0; k < MAX + 1; k++) sites.push({ key: 100 + k, x: k * 8, y: GROUND, z: 0, r: 4, gx: 0, gz: 0 })
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
