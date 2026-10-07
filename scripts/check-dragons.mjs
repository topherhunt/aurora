// Node-side gates for the dragons (src/v2/render/dragons.js) and their roosts
// (src/v2/render/roosts.js).
//
//   node scripts/check-dragons.mjs
//
// The shipped fen-dragon GLB is checked for shape first -- the halving ladder
// over one skeleton, the wyvern clip library with `fly` in it, the wyvern
// extras at the roster's size, a bind pose standing four-square on y = 0
// facing +X -- because the world loads it by name and builds every puppet from
// it. Then the roost: the fortress bank (a squashed plate, a ring of stones on
// it, pebbles and logs inside, every tier its own LOD) and the scatter, which
// seats one roost per tile within SEAT_REACH of its highest summit near the
// snow line, none beside a higher one, the same twice, and turns one away from
// water and roads. Then the dragons,
// a stand-in slab whose `fly` swings its wings out, over a stand-in roost and
// herd: one dragon's score, flight, meal, explore, lure, aggro and drawing on
// the male alone (Solo), then the pair -- the guard resting on its half of the
// nest every chapter while the male flies, the two abreast, each its own
// colour -- and that the pair goes with its roost.
//
// What this can NOT check: whether a dragon coming over the ridge is a thing
// to see. That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import {
  Dragons, CLIPS, DRAGON_VIEWS, MAX, PUPPETS, SIZE_VARY, PATROL_MPS, DIVE_MPS, LAND_MPS, ACCEL, STRIDE_ACCEL,
  TURN_RATE, LAND_TURN_RATE, PITCH_RATE, BANK, ROLL_RATE, PATROL_M, MIN_AGL, LAND_M, LOITER_PACE, REST_S, FLIGHT_MIN_S, PERCH_S, EAT_S,
  WAY, WALK_TURN_RATE, EAT_REACH, EASE_MPS, EASE_TURN, SPOT_AWAY, SPOT_SLOPE_DEG, SCALE_ROUGHNESS, measureFly, keyOf, GUARD_VIVID, MALE_VIVID, WALK_RING,
  HUNT_M, HUNT_MPS, STOOP_M, STOOP_AGL, STRIKE_AGL, MEAL_S,
  LURES, LURE, LURE_FORGET, MENACE_RUN, MENACE, ANCHOR_S, ANCHOR_STALE_S,
  SPOT_M, EYE_M, EYE_P, CIRCLE_M, LAND_SHORT, SPOT_S, CHARGE_MPS, BITE_M, HURT_M, BITE_HP, BITE_AT_S, CHOMP_S, GROWL_S, GIVE_UP_M, SPURN_S, AGGRO_ANCHOR_S, HER as HER_ID,
} from '../src/v2/render/dragons.js'
import { CATCH_UP_TICKS, CHAPTER_S, TICK_S, chapterOf, tickAfter, tickOf } from '../src/sim/score.js'
import {
  Roosts, TILE, SPACING, SEAT_REACH, MAX_TILT, WIDTH, FLOOR_R, LODS, RADIUS_M, SCREE, WALL_RISE, CELL, GRID_N, NEST_FERNS, REACH, buildFortress, layFortress, gridCell,
  EGG_GLB, EGG_ODDS, EGG_HEIGHT, EGG_TINTS, EGG_LIE, EGG_SINK, EGG_ROUGHNESS, eggBankFrom,
} from '../src/v2/render/roosts.js'
import { buildRockBank } from '../src/props/rock-bank.js'
import { LAYER, buildTextureArray } from '../src/textures.js'
import { LOCOMOTION } from '../src/player.js'
import { WALK } from '../src/v2/walk.js'
import { propCull } from '../src/v2/render/gen-props.js'
import { CARD_RUNGS, CRITTER_GLB, GLINT, LOD_RUNGS, lodReach } from '../src/v2/render/critters.js'
import { CREATURES, shipTexPx } from '../tools/creatures/creature-roster.mjs'
import { readAccessor, readGlb } from '../tools/creatures/apply-rig-edit.mjs'
import { webpSize } from '../tools/tripo-pack.mjs'
import { BEND_MAX, TailLag } from '../src/v2/render/tail-lag.js'
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
  check(wyvern?.tail?.length >= 2 && wyvern.tail.every((n) => jointNames.has(n)), `${id}: the tail named root to tip, every joint one of the skeleton's -- its lag bends them`, wyvern?.tail?.join('>'))

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

// --- the roost's fortress ------------------------------------------------------------
// The rocks' own boulder, for the fortress to be built of, and a stand-in Rocks round it with a peak tint, recording the ground it is asked for.
const BOULDER = buildRockBank().shapes.boulder
const TINT = [0.55, 0.6, 0.7]
const tintedFor = new Set()
const ROCKS = { boulder: () => ({ tiers: BOULDER.tiers, measured: BOULDER.measured, material: null }), tintAt: (x, z, env, out) => { tintedFor.add(env); return out.setRGB(...TINT) } }
const TEXTURES = buildTextureArray()
const patched = []
const PATCH = (m, key) => { patched.push(key); return m }
// Her climb, as the gate floods it: a cell she may step up to within her reach, unless the ground 1.5 m on rises steeper than the slope limiter allows.
const STRIDE_CELLS = Math.round(LOCOMOTION.stride / CELL)
const STRIDE_RISE = Math.tan((LOCOMOTION.maxSlopeDeg * Math.PI) / 180) * LOCOMOTION.stride
/** The cells she can walk to from outside the grid, over the walk grid laid on `groundAt`. */
function floodIn(grid, groundAt) {
  const at = (k) => (k + 0.5) * CELL - (GRID_N * CELL) / 2
  const surf = new Float64Array(GRID_N * GRID_N)
  for (let j = 0; j < GRID_N; j++) for (let i = 0; i < GRID_N; i++) surf[j * GRID_N + i] = Math.max(grid.top[j * GRID_N + i], groundAt(at(i), at(j)))
  const seen = new Uint8Array(GRID_N * GRID_N)
  const queue = []
  for (let k = 0; k < GRID_N; k++) for (const c of [k, (GRID_N - 1) * GRID_N + k, k * GRID_N, k * GRID_N + GRID_N - 1]) if (!seen[c]) { seen[c] = 1; queue.push(c) }
  while (queue.length) {
    const c = queue.pop()
    const i = c % GRID_N, j = (c - i) / GRID_N
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj
      if (ni < 0 || nj < 0 || ni >= GRID_N || nj >= GRID_N) continue
      const n = nj * GRID_N + ni
      if (seen[n] || surf[n] - surf[c] > WALK.reach) continue
      const fi = i + di * STRIDE_CELLS, fj = j + dj * STRIDE_CELLS
      if (fi >= 0 && fj >= 0 && fi < GRID_N && fj < GRID_N && surf[fj * GRID_N + fi] - surf[c] > STRIDE_RISE) continue
      seen[n] = 1
      queue.push(n)
    }
  }
  return seen
}
console.log('\nroost fortress')
{
  // Ground falling 0.15 per metre along +X under a ripple, for every stone to be set into.
  const rough = (x, z) => -0.15 * x + 0.4 * Math.sin(x * 0.7) * Math.cos(z * 0.5)
  const f = buildFortress(BOULDER, 7, rough, TINT)
  const again = buildFortress(BOULDER, 7, rough, TINT)
  const other = buildFortress(BOULDER, 8, rough, TINT)
  check(f.geometries.length === LODS && f.tris.every((t, k) => k === 0 || t < f.tris[k - 1]), `${LODS} tiers, each fewer triangles than the one above`, f.tris.join('/'))
  check(f.geometries.every((g) => g.index && g.groups.length === 0 && ['position', 'normal', 'uvProj', 'texLayer', 'color'].every((a) => g.getAttribute(a))), 'every tier is one indexed geometry on the prop material\'s attributes and a vertex colour, so a roost is one draw')
  const layersOf = (g) => new Set(g.getAttribute('texLayer').array)
  check(f.geometries.every((g, k) => layersOf(g).has(LAYER.BARK) === (k < LODS - 1) && [...layersOf(g)].some((l) => l !== LAYER.BARK)), 'stone on every tier and logs in bark on all but the last', f.geometries.map((g) => [...layersOf(g)].join(',')).join(' / '))
  const b = f.geometries[0].boundingBox
  check(b.max.x - b.min.x > WIDTH * 0.85 && b.max.x - b.min.x < WIDTH * 1.1 && b.max.z - b.min.z > WIDTH * 0.85 && b.max.z - b.min.z < WIDTH * 1.1, `about ${WIDTH} m across`, `${fmt(b.max.x - b.min.x)} x ${fmt(b.max.z - b.min.z)} m`)
  const pos = (g) => g.getAttribute('position').array
  check(pos(f.geometries[0]).every((x, i) => x === pos(again.geometries[0])[i]) && pos(f.geometries[0]).some((x, i) => x !== pos(other.geometries[0])[i]), 'the fortress is a function of its seed: the same twice, another with another seed')

  const wall = f.stones.filter((s) => s.wall)
  const scree = f.stones.filter((s) => !s.wall)
  check(wall.every((s) => s.bottom < s.ground[0] && s.top - s.ground[1] >= WALL_RISE - 1e-6), `every wall stone bedded under its lowest ground and standing WALL_RISE ${WALL_RISE} m over its highest`, `lowest rise ${fmt(Math.min(...wall.map((s) => s.top - s.ground[1])))} m`)
  check(f.stones.every((s) => s.bottom < s.ground[0]), 'and every other stone set into the ground, none sitting on it')
  // The scree in thirds by distance out: each smaller than the one outside it.
  const out = (s) => Math.hypot(s.x, s.z)
  const thirds = [0, 1, 2].map((k) => scree.filter((s) => out(s) >= FLOOR_R + (k * (SCREE.out - FLOOR_R)) / 3 && out(s) < FLOOR_R + ((k + 1) * (SCREE.out - FLOOR_R)) / 3))
  const meanAcross = thirds.map((ss) => ss.reduce((n, s) => n + s.across, 0) / ss.length)
  check(meanAcross[0] < meanAcross[1] && meanAcross[1] < meanAcross[2] && scree.length > 5 * wall.length, 'the scree grades from the wall in, smaller towards the floor, many stones to each of the wall\'s', `${scree.length} against ${wall.length}; ${thirds.map((ss, k) => `${ss.length}x${fmt(meanAcross[k])}`).join(' ')}`)
  // Not rings: no 0.4 m band of distance out holds a fifth of the scree, and stones of a size lie at many distances.
  let crowd = 0
  for (let r = FLOOR_R; r < SCREE.out; r += 0.1) crowd = Math.max(crowd, scree.filter((s) => out(s) >= r && out(s) < r + 0.4).length)
  const mid = scree.filter((s) => s.across > 0.8 && s.across < 1.2).map(out)
  check(crowd < scree.length / 5 && Math.max(...mid) - Math.min(...mid) > 1.5, 'and is scattered, not ringed: no narrow band of distance crowded, a stone of a size found at many distances', `most in 0.4 m: ${crowd} of ${scree.length}; 0.8-1.2 m stones over ${fmt(Math.max(...mid) - Math.min(...mid))} m`)
  const overlaps = scree.filter((s) => f.stones.some((o) => o !== s && Math.hypot(o.x - s.x, o.z - s.z) < 0.8 * (s.across + o.across) / 2)).length
  const heaped = scree.filter((s) => s.ground[1] > rough(s.x, s.z) + 0.6).length
  check(overlaps > scree.length / 2 && heaped > scree.length / 10, 'heaped: most stones overlap a neighbour, and some lie up on another', `${overlaps} overlapping, ${heaped} heaped of ${scree.length}`)
  // The logs thrown down anyhow: at many headings to the ring and distances out, none across the floor.
  const across = f.logs.map((l) => Math.abs(Math.sin(l.yaw + Math.atan2(l.z, l.x))))
  const reach = f.logs.map((l) => { const ux = Math.cos(l.yaw), uz = -Math.sin(l.yaw), t = Math.max(-l.len / 2, Math.min(l.len / 2, -(l.x * ux + l.z * uz))); return Math.hypot(l.x + ux * t, l.z + uz * t) })
  check(Math.max(...across) - Math.min(...across) > 0.5 && Math.max(...f.logs.map(out)) - Math.min(...f.logs.map(out)) > 0.8 && reach.every((r) => r > FLOOR_R), 'the logs lie anyhow -- along, across and aslant the ring, near and far out -- and none over the floor', `nearest ${fmt(Math.min(...reach))} m`)
  const spread = (v) => Math.max(...v) / Math.min(...v)
  check(spread(wall.map((s) => s.across)) > 1.25 && spread(wall.map((s) => s.tall / s.across)) > 1.2 && spread(wall.map((s) => s.depth / s.across)) > 1.2, 'the wall\'s stones vary in size, height and squash', `across x${fmt(spread(wall.map((s) => s.across)))}, tall x${fmt(spread(wall.map((s) => s.tall / s.across)))}, deep x${fmt(spread(wall.map((s) => s.depth / s.across)))}`)
  const warmth = f.stones.map((s) => s.color[0] / s.color[2])
  check(spread(f.stones.map((s) => s.color[1])) > 1.2 && spread(warmth) > 1.2 && f.stones.every((s) => s.color[1] > TINT[1] * 0.8 && s.color[1] < TINT[1] * 1.15), 'each stone its own shade and warmth of the peak\'s stone, none far from it', `light x${fmt(spread(f.stones.map((s) => s.color[1])))}, warmth x${fmt(spread(warmth))}`)
  check(f.stones.every((s) => Math.hypot(s.x, s.z) - s.across / 2 > FLOOR_R) && [gridCell(0, 0), gridCell(FLOOR_R - CELL, 0), gridCell(0, -(FLOOR_R - CELL))].every((c) => f.grid.top[c] === -Infinity), `the floor is clear of stone out to FLOOR_R ${FLOOR_R} m`)
  const fd = f.ferns.length / (Math.PI * (NEST_FERNS.out ** 2 - NEST_FERNS.clear ** 2))
  check(fd > 0.6 && f.ferns.every((p) => Math.hypot(p.u, p.v) >= NEST_FERNS.clear && Math.hypot(p.u, p.v) <= NEST_FERNS.out && p.y - rough(p.u, p.v) <= NEST_FERNS.lift + 1e-9), 'ferns thick through the nest, off the egg, inside the wall and none up on a stone', `${f.ferns.length} at ${fmt(fd)}/m^2`)
  check(JSON.stringify(layFortress(BOULDER, 7, rough, TINT).ferns) === JSON.stringify(f.ferns), 'and laid out without the geometry, the same ferns')

  // Watertight: walked at from every side, on rough ground and flat, nothing reaches the floor.
  const flat = () => 0
  for (const [name, ground, seeds] of [['rough', rough, [7, 8, 9, 10]], ['flat', flat, [11, 12, 13, 14]]]) {
    let leaks = 0, outside = 0
    for (const seed of seeds) {
      const g = buildFortress(BOULDER, seed, ground, TINT)
      const seen = floodIn(g.grid, ground)
      outside += seen.reduce((n, v) => n + v, 0)
      for (let c = 0; c < seen.length; c++) {
        const i = c % GRID_N, j = (c - i) / GRID_N
        if (seen[c] && Math.hypot((i + 0.5) * CELL - (GRID_N * CELL) / 2, (j + 0.5) * CELL - (GRID_N * CELL) / 2) < FLOOR_R) leaks++
      }
      for (const geo of g.geometries) geo.dispose()
    }
    check(leaks === 0 && outside > 4 * (GRID_N * GRID_N) * 0.3, `the wall is closed on ${name} ground: walked at from outside, she reaches no cell of the floor over four seeds`, `${leaks} floor cells reached`)
  }
  for (const g of [f, again, other]) for (const geo of g.geometries) geo.dispose()
}

// --- the roost's placement ------------------------------------------------------------
console.log('\nroost placement')
const DRY = { isSubmerged: () => false }
const WET = { isSubmerged: () => true }
const LAYERS = { paths: { nearest: () => null } }
const ROADS = { paths: { nearest: () => ({ dist: 0, halfWidth: 3 }) } }
const flatField = (h, tan = 0) => ({ heightAt: () => h, heightAndSlopeAt: () => ({ h, tan }), snowLineAt: () => Infinity })
// A planar hillside rising gx per metre along +X and gz along +Z.
const hillField = (h0, gx, gz) => ({ heightAt: (x, z) => h0 + gx * x + gz * z, heightAndSlopeAt: (x, z) => ({ h: h0 + gx * x + gz * z, tan: Math.hypot(gx, gz) }), snowLineAt: () => Infinity })
const GROUND = 12
// Round peaks [x, z, top] on a 50 m plain under a snow line at SNOW: A, C and E are roosts; B is within SPACING of the higher A, and D stands more than BELOW_SNOW under the snow.
const PEAKS = { A: [300, 300, 900], B: [800, 300, 850], C: [300, 2400, 800], D: [2400, 2400, 250], E: [2400, 300, 700] }
const SNOW = 500
const peakField = (snow = SNOW) => {
  const heightAt = (x, z) => {
    let h = 50
    for (const [px, pz, top] of Object.values(PEAKS)) h += (top - 50) * Math.exp(-((x - px) ** 2 + (z - pz) ** 2) / (2 * 120 * 120))
    return h
  }
  return { heightAt, heightAndSlopeAt: (x, z) => ({ h: heightAt(x, z), tan: Math.hypot(heightAt(x + 0.5, z) - heightAt(x - 0.5, z), heightAt(x, z + 0.5) - heightAt(x, z - 0.5)) }), snowLineAt: () => snow }
}
// Every peak is inside this from MID.
const MID = [1350, 1350]
const ROOST_R = 1600
const roostsOn = ({ field = peakField(), water = DRY, layers = LAYERS, seed = 5, egg = null, radius = ROOST_R, at = MID, Kind = Roosts } = {}) => {
  const r = new Kind(new THREE.Scene(), field, water, layers, { seed, rocks: ROCKS, egg, radius, textures: TEXTURES, patch: PATCH })
  r.place(...at)
  return r
}
const peakOf = (s) => Object.keys(PEAKS).reduce((a, n) => (Math.hypot(s.x - PEAKS[n][0], s.z - PEAKS[n][1]) < Math.hypot(s.x - PEAKS[a][0], s.z - PEAKS[a][1]) ? n : a))
// The same land with every floor tilted to (0.1, -0.12): what the egg is laid on is the site's plane, whatever made it.
class Tilted extends Roosts {
  _roll(key, tx, tz) {
    const out = super._roll(key, tx, tz)
    if (out.site) Object.assign(out.site, { gx: 0.1, gz: -0.12 })
    return out
  }
}
{
  const field = peakField()
  patched.length = 0
  const r = roostsOn({ field })
  const sites = r.sites()
  check(sites.map(peakOf).sort().join('') === 'ACE', 'a roost on every summit within BELOW_SNOW of the snow line and highest within SPACING: A, C and E, not B beside the higher A, nor D low under the snow', sites.map(peakOf).join(''))
  const off = sites.map((s) => Math.hypot(s.x - PEAKS[peakOf(s)][0], s.z - PEAKS[peakOf(s)][1]))
  check(off.every((d) => d <= SEAT_REACH), `each seated within SEAT_REACH ${SEAT_REACH} m of its summit`, off.map(fmt).join(' '))
  check(sites.every((s) => s.y === field.heightAt(s.x, s.z) && Math.hypot(s.gx, s.gz) <= MAX_TILT + 1e-12), 'its floor on the ground at its centre, tilted no more than MAX_TILT')
  check(sites.every((s) => Number.isFinite(s.key) && s.r === FLOOR_R && r.tiles.has(s.key) && r.tiles.get(s.key).site === s) && new Set(sites.map((s) => s.key)).size === sites.length, `every site keyed by its territory, one to a territory, its floor's clear radius FLOOR_R`)
  const pose = (q) => q.sites().map(({ x, y, z, gx, gz }) => [x, y, z, gx, gz].join())
  check(JSON.stringify(sites) === JSON.stringify(roostsOn({ field }).sites()) && JSON.stringify(pose(r)) === JSON.stringify(pose(roostsOn({ field, seed: 9 }))), 'the same seed lays the same roosts twice, and another seed lays them on the same seats: the summits are the land\'s')
  check(r.place(...MID) === sites.length && pose(r).join() === sites.map(({ x, y, z, gx, gz }) => [x, y, z, gx, gz].join()).join(), 'a relief edit under the same camera lays the same set again')
  const meshes = sites.map((s) => r.tiles.get(s.key).mesh)
  check(r.group.name === 'v2-roosts' && r.batch === null && r.group.children.length === sites.length && meshes.every((m, k) => r.group.children.includes(m) && m.material === r.material && m.position.x === sites[k].x && m.position.y === sites[k].y && m.position.z === sites[k].z), 'with no egg bank the group holds one mesh a roost at its floor\'s centre, all on the one stone material, and no egg arena')
  check(r.material.vertexColors && patched.includes('v2-roost-stone'), 'the stone takes its tint from the vertex colour, and goes to the lighting', patched.join(' '))
  const greens = meshes.flatMap((m) => Array.from(m.geometry.getAttribute('color').array.filter((_, i) => i % 3 === 1)))
  check(greens.every((g) => g > TINT[1] * 0.8 && g < TINT[1] * 1.15) && [...tintedFor].join() === 'peak', 'each tinted round the rocks\' stone on a peak')
  check(r.radius === ROOST_R && RADIUS_M >= SPACING, `the radius is the one asked for; the world's ${RADIUS_M} m is past SPACING, so a neighbour's roost is always resident`)

  // The LOD on the rocks' ladder at the fortress's size: on top at its floor, lower further off.
  const a = sites.find((s) => peakOf(s) === 'A')
  const ta = r.tiles.get(a.key)
  const tierFrom = (d) => { r.update(a.x + d, a.y + 1.7, a.z); return ta.tier }
  const tiers = [0, 100, 400, 0].map(tierFrom)
  check(tiers.join() === `0,2,${LODS - 1},0` && ta.mesh.geometry === ta.geometries[0] && r.stats.tris > 0, 'standing in it, the top tier; 100 m off the third; 400 m off the last; back in it, the top again', tiers.join(' '))
  r.update(a.x + 4000, a.y, a.z)
  check(r.sites().length === 0 && r.group.children.length === 0 && !r.tiles.has(a.key), 'walked 4 km off, every roost is released and its mesh gone')
  r.dispose()

  // Past the radius: siteAt answers what the wide world laid, and null where it laid none.
  const narrow = roostsOn({ field, radius: 400, at: [a.x, a.z] })
  const tileOf = (p) => [Math.floor(p[0] / TILE), Math.floor(p[1] / TILE)]
  const far = sites.find((s) => peakOf(s) === 'C')
  check(narrow.sites().length === 1 && JSON.stringify(narrow.siteAt(far.tx, far.tz)) === JSON.stringify(far) && narrow.siteAt(...tileOf(PEAKS.B)) === null && narrow.siteAt(...tileOf(PEAKS.D)) === null, 'siteAt past the radius is the site the wide world laid, and null for B and D')
  const wide = roostsOn({ field })
  const box = [far.x - 4, far.z - 9, far.x + 9, far.z + 2]
  const nested = narrow.fernsIn(...box, [])
  check(nested.length > 20 && JSON.stringify(nested) === JSON.stringify(wide.fernsIn(...box, [])) && nested.every((p) => p.x >= box[0] && p.x < box[2] && p.z >= box[1] && p.z < box[3]), 'fernsIn past the radius are the ferns the resident roost holds, cut to the box', `${nested.length}`)
  check(narrow.fernsBound(83) === NEST_FERNS.tries && narrow.fernsBound(SPACING) > NEST_FERNS.tries, 'a fern bed\'s disc holds one nest\'s ferns at most')
  check(narrow.occupiesAt(far.x, far.z, 0) && narrow.occupiesAt(far.x + REACH - 0.5, far.z, 0) && narrow.occupiesAt(far.x + REACH + 0.5, far.z, 1) && !narrow.occupiesAt(far.x + REACH + 1.5, far.z, 1), 'a trunk keeps out of the roost past the radius, out to its wall\'s reach and pad')
  wide.dispose()
  narrow.dispose()

  // To the walker the stones are the walk grid's spans over the fortress, the floor is the field's, and past the grid there is nothing.
  const w = roostsOn({ field })
  const t = w.tiles.get(w.sites().find((s) => peakOf(s) === 'A').key)
  const s = t.site
  const spans = new Float64Array(16)
  let hi = 0
  for (let c = 1; c < t.grid.top.length; c++) if (t.grid.top[c] > t.grid.top[hi]) hi = c
  const hx = s.x + ((hi % GRID_N) + 0.5) * CELL - (GRID_N * CELL) / 2, hz = s.z + (Math.floor(hi / GRID_N) + 0.5) * CELL - (GRID_N * CELL) / 2
  const n = w.columnAt(hx, hz, 0, spans)
  check(n === 1 && spans[1] === s.y + t.grid.top[hi] && w.blockTopAt(hx, hz) === spans[1] && spans[0] < field.heightAt(hx, hz) && spans[1] - field.heightAt(hx, hz) > WALK.height, 'over the tallest stone, one span from under the ground to over her head', `${fmt(spans[0] - s.y)}..${fmt(spans[1] - s.y)} m`)
  check(w.blockTopAt(s.x, s.z) === -Infinity && w.columnAt(s.x, s.z, 0, spans) === 0, 'on the floor, no stone: she stands on the field')
  check(w.blockTopAt(s.x + WIDTH, s.z) === -Infinity && w.columnAt(s.x + WIDTH, s.z, 0, spans) === 0, 'and a fortress-width off it, no stone at all')
  w.dispose()

  const snowless = roostsOn({ field: peakField(2000) })
  const wet = roostsOn({ water: WET })
  const road = roostsOn({ layers: ROADS })
  check(snowless.stats.placed === 0, 'with the snow line far over every peak there are none')
  check(wet.stats.placed === 0 && wet.stats.rejected.water === 3, 'none drowned, counted against the water', JSON.stringify(wet.stats.rejected))
  check(road.stats.placed === 0 && road.stats.rejected.path === 3, 'nor on a road, counted against the path', JSON.stringify(road.stats.rejected))
  for (const q of [snowless, wet, road]) q.dispose()
}

// --- the egg in the nest ----------------------------------------------------------------
console.log('\nroost egg')
// A stand-in pick the shape of the shipped egg: an ellipsoid on its broad end with its foot on y = 0, as loadCritterGlb frames a pick.
const pickOf = (w, h, d) => {
  const g = new THREE.SphereGeometry(0.5, 48, 32).scale(w, h, d).translate(0, h / 2, 0)
  return { pos: g.getAttribute('position').array, nrm: g.getAttribute('normal').array, uv: g.getAttribute('uv').array, idx: Array.from(g.index.array), map: null }
}
{
  const throws = (fn) => { try { fn(); return false } catch { return true } }
  check(fs.existsSync(new URL(`../public/${EGG_GLB}`, import.meta.url)) && fs.existsSync(new URL(`../public/${EGG_GLB.replace(/\.glb$/, '.webp')}`, import.meta.url)), `${EGG_GLB} and its map are shipped -- run tools/props/gen/ship.mjs egg-dragon`)
  check(throws(() => eggBankFrom(pickOf(1, 0.6, 0.6))), 'eggBankFrom refuses a pick lying on its side')
  const egg = eggBankFrom(pickOf(0.6, 1, 0.6))
  const bb = egg.geometry.boundingBox
  check(Math.abs(egg.bounds.height - 1) < 1e-6 && Math.abs(egg.bounds.width - 0.6) < 1e-6 && Math.abs(bb.min.y + 0.5) < 1e-6 && Math.abs(bb.max.y - 0.5) < 1e-6 && egg.tris > 0, 'and takes a standing one, its origin moved from the foot to the middle it is turned about', `${fmt(egg.bounds.width)} x ${fmt(egg.bounds.height)}, y ${fmt(bb.min.y)}..${fmt(bb.max.y)}, ${egg.tris} tris`)
  const c = new THREE.Color()
  check(EGG_TINTS.length === 5 && EGG_TINTS.every(([name, hex]) => typeof name === 'string' && !(c.setHex(hex).r > 0.8 && c.g > 0.8 && c.b > 0.8)), 'five clutch colours, none of them white -- a white tint is the unpainted pick', EGG_TINTS.map(([n]) => n).join(' '))
  check(EGG_ODDS > 0 && EGG_ODDS < 1 && EGG_LIE[0] > 0 && EGG_LIE[1] < Math.PI / 2 && EGG_HEIGHT[0] > 0 && EGG_HEIGHT[1] < 1, 'an egg is a chance, lies over short of flat, and is under a metre tall')

  const r = roostsOn({ egg })
  const bare = roostsOn()
  check(r.batch.name === 'v2-roost-eggs' && r.group.children.includes(r.batch) && r.batch.meshes.length === 1 && r.eggMaterial.customProgramCacheKey() === 'gen-prop-gloss', 'with a bank the eggs are an arena of their own in the roosts\' group, one tier, on the gloss gen-prop material', r.eggMaterial.customProgramCacheKey())
  // The shine: a Standard at EGG_ROUGHNESS with no metalness, the whole lobe left on it, and the rim fade still spliced in.
  check(r.eggMaterial.isMeshStandardMaterial && r.eggMaterial.roughness === EGG_ROUGHNESS && EGG_ROUGHNESS > 0 && EGG_ROUGHNESS <= 0.3 && r.eggMaterial.metalness === 0, 'the egg is a Standard material at EGG_ROUGHNESS, no rougher than the wet creatures, with no metalness', `${r.eggMaterial.type} roughness ${r.eggMaterial.roughness}`)
  {
    const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <map_fragment>\n#include <normal_fragment_begin>\n#include <lights_fragment_end>\n' }
    r.eggMaterial.onBeforeCompile(shader)
    check(shader.vertexShader.includes('attribute float aPropFade;') && shader.fragmentShader.includes('vPropFade'), 'and dithers out at the rim like every prop')
    check(!shader.fragmentShader.includes('reflectedLight.directSpecular *='), 'with the sun\'s whole lobe on the shell, not the creatures\' halved glint')
  }
  check(JSON.stringify(r.sites()) === JSON.stringify(bare.sites()) && r.stats.placed === bare.stats.placed, 'the eggs move no roost: the same seed lays the same sites with them or without', `${r.stats.placed} sites`)
  check(r.stats.pool === r.batch._max && r.stats.pool > r.stats.placed && bare.stats.pool === 0, 'and the pool holds an egg for every resident roost, plus the fades; with no bank there is none', `pool ${r.stats.pool} over ${r.stats.placed} roosts`)
  bare.dispose()
  r.dispose()

  // Every egg over sixty seeds: at its floor's centre, tinted from the clutch, laid over within EGG_LIE, EGG_HEIGHT tall, its lowest point EGG_SINK of its width into a floor tilted to (0.1, -0.12). The matrices come back as float32, so the tolerances are metres of that.
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(), v = new THREE.Vector3(), n = new THREE.Vector3(), lift = new THREE.Vector3()
  const pos = egg.geometry.getAttribute('position')
  const tints = new Set()
  let placed = 0, eggCount = 0, alongOff = 0, restOff = 0, lieLo = Infinity, lieHi = -Infinity, hLo = Infinity, hHi = -Infinity, badScale = 0, badCull = 0
  for (let seed = 1; seed <= 60; seed++) {
    const w = roostsOn({ egg, seed, Kind: Tilted })
    placed += w.stats.placed
    for (const t of w.tiles.values()) {
      if (t.n !== 1) continue
      eggCount++
      const id = t.ids[0]
      w.batch.getMatrixAt(id, m)
      m.decompose(p, q, s)
      n.set(-t.site.gx, 1, -t.site.gz).normalize()
      lift.set(p.x - t.site.x, p.y - t.site.y, p.z - t.site.z)
      alongOff = Math.max(alongOff, lift.clone().cross(n).length())
      const height = s.y * egg.bounds.height
      hLo = Math.min(hLo, height); hHi = Math.max(hHi, height)
      if (Math.abs(s.x - s.y) > 1e-6 || Math.abs(s.z - s.y) > 1e-6 || Math.abs(w.instR[id] - height) > 1e-6) badScale++
      const lie = Math.acos(up.set(0, 1, 0).applyQuaternion(q).dot(n))
      lieLo = Math.min(lieLo, lie); lieHi = Math.max(lieHi, lie)
      // The lowest point over the tilted floor: every vertex's height along the normal, against the floor's.
      let low = Infinity
      for (let i = 0; i < pos.count; i++) low = Math.min(low, v.fromBufferAttribute(pos, i).applyMatrix4(m).sub(p).dot(n))
      restOff = Math.max(restOff, Math.abs(lift.dot(n) + low + EGG_SINK * s.x * egg.bounds.width))
      tints.add(w.batch.getColorAt(id, c).getHex())
      if (Math.abs(w.rim.gone[id] - Math.min(w.radius, propCull(height))) > 1e-3) badCull++
    }
    w.dispose()
  }
  check(Math.abs(eggCount - placed * EGG_ODDS) < 3.5 * Math.sqrt(placed * EGG_ODDS * (1 - EGG_ODDS)), `over sixty seeds ${EGG_ODDS} of the roosts hold an egg and the rest are empty`, `${eggCount} eggs in ${placed} roosts`)
  check(alongOff < 1e-3, 'every egg is lifted from its floor\'s centre along the floor\'s normal', `off the normal by ${alongOff.toExponential(1)} m`)
  check(lieLo >= EGG_LIE[0] - 1e-6 && lieHi <= EGG_LIE[1] + 1e-6 && lieHi - lieLo > 0.2, `laid over ${EGG_LIE[0]}..${EGG_LIE[1]} rad off the floor's normal, no two alike`, `lie ${fmt(lieLo)}..${fmt(lieHi)}`)
  check(hLo >= EGG_HEIGHT[0] - 1e-6 && hHi <= EGG_HEIGHT[1] + 1e-6 && hHi - hLo > 0.05 && badScale === 0, `${EGG_HEIGHT[0]}..${EGG_HEIGHT[1]} m tall, scaled evenly, its height its rim size`, `${fmt(hLo)}..${fmt(hHi)} m, ${badScale} scaled unevenly`)
  check(restOff < 0.01, `its lowest point ${EGG_SINK} of its width into the floor, on a stand-in ellipsoid's own vertices`, `rest off ${restOff.toExponential(1)} m`)
  check([...tints].every((hex) => EGG_TINTS.some(([, h]) => h === hex)) && tints.size === EGG_TINTS.length, 'every egg tinted one of the clutch colours and every colour showing, so none white', [...tints].map((h) => EGG_TINTS.find(([, x]) => x === h)?.[0]).join(' '))
  check(badCull === 0, 'each culled where a prop of its height is', `${badCull} off cull`)
}

// A seed whose three roosts hold two eggs or more, for the sweeps and the hand.
const EGG_SEED = (() => {
  const egg = eggBankFrom(pickOf(0.6, 1, 0.6))
  for (let seed = 1; ; seed++) {
    const r = roostsOn({ egg, seed })
    const eggs = r.stats.eggs
    r.dispose()
    if (eggs >= 2) return seed
  }
})()
{
  const egg = eggBankFrom(pickOf(0.6, 1, 0.6))
  const r = roostsOn({ egg, seed: EGG_SEED })
  const eggTiles = [...r.tiles.values()].filter((t) => t.n === 1)
  const at = eggTiles[0].site
  r.update(at.x, at.y + 1.7, at.z)
  const bareAgain = roostsOn({ seed: EGG_SEED })
  bareAgain.update(at.x, at.y + 1.7, at.z)
  const shown = eggTiles.filter((t) => !r.rim.isHidden(t.ids[0])).length
  check(shown > 0 && r.stats.tris === bareAgain.stats.tris + shown * egg.tris, 'a frame later the eggs in sight are counted whole, over the roosts\' own count', `${shown} eggs shown, ${r.stats.tris} tris against ${bareAgain.stats.tris}`)
  bareAgain.dispose()
  r.update(at.x + 4000, at.y, at.z)
  check(r.stats.used === 0 && r.stats.eggs === 0 && r.stats.placed === 0, 'walked 4 km off, every egg she left is released with its roost')
  r.dispose()
}

// --- the egg in her hand ------------------------------------------------------------------
console.log('\nroost egg taken')
{
  const egg = eggBankFrom(pickOf(0.6, 1, 0.6))
  taken.clear()
  // Grown and swept from over one nest with an egg -- the first, or the one at (x, z) -- so the eggs in sight are shown.
  const grow = (x = null, z = null) => {
    const r = roostsOn({ egg, seed: EGG_SEED })
    const t = x === null ? [...r.tiles.values()].find((t) => t.n === 1).site : { x, z }
    r.update(t.x, PEAKS.A[2], t.z)
    return r
  }
  const r = grow()
  const tile = [...r.tiles.values()].find((t) => t.n === 1 && !r.rim.isHidden(t.ids[0]))
  const first = [...r.tiles.values()].find((t) => t.n === 1).site
  const at = { x: first.x, z: first.z }
  const id = tile.ids[0]
  const eggsWere = r.stats.eggs, placedWere = r.stats.placed, usedWere = r.stats.used
  const hit = r.pickAt(r.instX[id], r.instY[id], r.instZ[id], 0.1, 2)
  check(hit !== null && hit.tile === tile && hit.id === id && hit.dist === 0 && hit.size === r.instR[id], 'pickAt at an egg\'s centre hits it, its size its height', hit ? `${fmt(hit.size)} m` : 'null')
  check(r.pickAt(r.instX[id], r.instY[id] + 5, r.instZ[id], 0.1, 2) === null, 'and nothing five metres above it')
  check(r.pickAt(r.instX[id], r.instY[id], r.instZ[id], 0.1, r.instR[id]) === null, 'nor one at or over maxSize')
  const c = r.batch.getColorAt(id, new THREE.Color()).getHex()
  const rec = r.take(hit, 1)
  check(rec.kind === 'egg' && rec.name === 'dragon egg' && rec.size === hit.size && rec.geometry === egg.geometry && rec.material === r.eggMaterial && rec.stowable === true, 'take: a stowable dragon egg on the pick\'s geometry and the shell\'s material')
  check(Math.abs(rec.scale[0] - rec.size / egg.bounds.height) < 1e-6 && rec.scale[1] === rec.scale[0] && rec.scale[2] === rec.scale[0] && new THREE.Color().setRGB(...rec.color).getHex() === c, 'scaled by its height over the pick, in its clutch tint', JSON.stringify(rec.scale))
  check(tile.n === 0 && r.stats.eggs === eggsWere - 1 && r.stats.placed === placedWere && r.stats.used === usedWere - 1 && !r.batch.getVisibleAt(id), 'the nest stands with no egg, the instance back in the pool', `${r.stats.eggs} eggs, ${r.stats.used} used`)
  check(taken.has('egg', tile.site.x, tile.site.z), 'the nest is recorded')
  check(r.pickAt(r.instX[id], r.instY[id], r.instZ[id], 0.1, 2)?.id !== id, 'and the egg cannot be taken twice')
  const d = r.dress({ kind: 'egg' })
  check(d.geometry === egg.geometry && d.material === r.eggMaterial, 'dress: the pick\'s geometry and the shell\'s material')
  let threw = false
  try { r.dress({ kind: 'fern' }) } catch { threw = true }
  check(threw, 'dress throws on another kind')
  const bare = roostsOn()
  check(bare.dress({ kind: 'egg' }) === null && bare.pickAt(PEAKS.A[0], PEAKS.A[2], PEAKS.A[1], 1000, 2) === null, 'a world with no eggs dresses none and offers none')
  bare.dispose()
  const again = grow(at.x, at.z)
  const same = [...again.tiles.values()].find((t) => t.tx === tile.tx && t.tz === tile.tz)
  check(same.n === 0 && again.stats.eggs === eggsWere - 1 && again.stats.placed === placedWere, 'grown again the nest lays no other egg and the rest are as they were', `${again.stats.eggs} eggs`)
  again.dispose()
  taken.clear()
  const whole = grow(at.x, at.z)
  check(whole.stats.eggs === eggsWere, 'and with the registry cleared the egg is back')
  // A peer's take: the egg evicted by its nest's site, hidden or shown; a nest without one, a foreign key and an empty spot are false.
  const te = [...whole.tiles.values()].find((t) => t.n === 1 && whole.rim.isHidden(t.ids[0])) ?? [...whole.tiles.values()].find((t) => t.n === 1)
  check(whole.evict('skull', te.site.x, te.site.z) === false && whole.evict('egg', te.site.x + 5, te.site.z) === false && whole.stats.eggs === eggsWere, 'evict is false for a foreign key or an empty spot')
  check(whole.evict('egg', te.site.x + 0.03, te.site.z - 0.03) === true && te.n === 0 && whole.stats.eggs === eggsWere - 1 && taken.has('egg', te.site.x, te.site.z), `evict lifts the egg a peer took, ${whole.rim.isHidden(te.ids[0]) ? 'rim-hidden' : 'shown'}, and records the nest`)
  check(whole.evict('egg', te.site.x, te.site.z) === false, 'and is false for the nest once emptied')
  whole.dispose()
  r.update(tile.site.x + 4000, GROUND + 1.7, tile.site.z)
  check(r.stats.used === r.stats.eggs, 'walked off, the nest releases cleanly without its egg')
  r.dispose()
  // A second world: an egg taken with stowMax at its height comes up in the hand but will not go in the backpack.
  taken.clear()
  const w = grow()
  const t2 = [...w.tiles.values()].find((t) => t.n === 1 && !w.rim.isHidden(t.ids[0]))
  const h2 = w.pickAt(w.instX[t2.ids[0]], w.instY[t2.ids[0]], w.instZ[t2.ids[0]], 0.1, 2)
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
  const tail = new THREE.Bone(); tail.name = 'Tail'; tail.position.set(-span / 4, height / 2, 0)
  const tail1 = new THREE.Bone(); tail1.name = 'Tail1'; tail1.position.set(-span / 8, 0, 0)
  tail.add(tail1)
  root.add(spine, tail); root.updateMatrixWorld(true)
  const bones = [root, spine, legBones[0][1], legBones[1][1], legBones[0][0], legBones[1][0], tail, tail1]
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
  return { root, skeleton, tiers, clips, map: null, sizeM: wyvern.sizeM, span, width, height, gait: { ...wyvern.gait }, legs, tail: ['Tail', 'Tail1'] }
}

/** A stand-in herd: `stags` the slots a dragon may roster, pose, kill, carry and drop, each standing still at its spawn, every call counted on the slot. */
function makeHerd(stags) {
  const of = (key) => { const s = stags.find((c) => c.key === key); if (!s) throw new Error(`no stag keyed ${key}`); return s }
  return {
    stags,
    hunter: null,
    roster(x, z, range, into = []) {
      this.rosterCalls++
      for (const s of stags) if (Math.hypot(s.x - x, s.z - z) <= range) into.push({ key: s.key, x: s.x, z: s.z })
      return into.sort((a, b) => (a.key < b.key ? -1 : 1))
    },
    rosterCalls: 0,
    spawnAt(key) { const s = of(key); return { x: s.x, z: s.z } },
    poseAt(key, T, into = { x: 0, y: 0, z: 0, heading: 0 }) { const s = of(key); into.x = s.x; into.y = s.y; into.z = s.z; into.heading = 0; return into },
    kill(key, now) { const c = of(key); c.spawn = null; c.act = 'dead'; c.seized++; c.killed.push(now); return c },
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
const stag = (x, z, y = GROUND, key = 'st:0,0:0') => ({ key, spawn: {}, x, y, z, k: 0.5, killed: [], size: 2, lod: 0, seized: 0, carried: 0, lain: null, lainFrames: 0, shown: null, shownFrames: 0, drops: [], at: new THREE.Vector3(), up: new THREE.Vector3() })
const roostOf = (sites) => ({ sites: (into = []) => { into.push(...sites); return into }, siteAt: (tx, tz) => sites.find((s) => s.tx === tx && s.tz === tz) ?? null })
const dry = { isSubmerged: () => false }
// Its bites are logged on it: `hurt` her [n, why], `frights` a strider's [key, x, z].
/** Dragons whose guards are never born: the gates of one dragon's own score, flight, meal and bite fly the male alone, and the pair is gated on its own. */
class Solo extends Dragons { _spawn(site, guard, now) { return guard ? null : super._spawn(site, guard, now) } }
const dragonsOn = (field, sites, herd, seed = 3, water = dry, Kind = Solo, ground = field) => {
  const hurt = [], frights = []
  const d = new Kind(new THREE.Scene(), field, { seed, ground, roosts: roostOf(sites), wildlife: herd, water, harm: (n, why) => hurt.push([n, why]), fright: (key, x, z) => frights.push([key, x, z]), asset: makeAsset() })
  return Object.assign(d, { hurt, frights })
}
const DT = 1 / 60
const HER = { x: 5, y: GROUND + 1.6, z: 5 }

// --- construction ----------------------------------------------------------------------
console.log('\ndragons')
{
  const flat = flatField(GROUND)
  check((() => { try { new Dragons(new THREE.Scene(), flat, { roosts: roostOf([]), wildlife: {}, asset: makeAsset() }); return false } catch (e) { return /roster, spawnAt, poseAt, kill, carry and drop/.test(e.message) } })(), 'a wildlife without the hunt\'s verbs is refused by name')
  check((() => { try { new Dragons(new THREE.Scene(), flat, { roosts: {}, wildlife: makeHerd([]), asset: makeAsset() }); return false } catch (e) { return /sites/.test(e.message) } })(), 'so is a roost layer with no sites()')
  check((() => { try { new Dragons(new THREE.Scene(), flat, { roosts: roostOf([]), wildlife: makeHerd([]), asset: makeAsset() }); return false } catch (e) { return /isSubmerged/.test(e.message) } })(), 'and a world with no water to ask, since a dragon must not alight in a lake')
  check((() => { try { new Dragons(new THREE.Scene(), flat, { roosts: roostOf([]), wildlife: makeHerd([]), water: dry, asset: makeAsset() }); return false } catch (e) { return /harm\(n, why\)/.test(e.message) } })(), 'and one with no harm or fright, since its bite must land on someone')

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

// --- the score: a chapter of phrases, closed-form, chained, home at both ends, the same everywhere ---
const homeSite = (key) => ({ key, tx: key, tz: 0, x: 0, y: GROUND, z: 0, r: FLOOR_R, gx: 0, gz: 0 })
/** A plan of nothing but rests on the nest, `durs` seconds each, for the gates that want the dragon kept home. */
const restPlan = (d) => (key) => {
  const dr = d.byKey.get(key)
  return [300, 300].map((dur) => ({ kind: 'rest', dur, from: dr.home, to: dr.home, at: dr.site, meal: false }))
}
const pose = (dr) => ({ x: dr.x, y: dr.y, z: dr.z, heading: dr.heading, pitch: dr.pitch, roll: dr.roll, speed: dr.speed })
const samePose = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z && a.heading === b.heading && a.pitch === b.pitch && a.roll === b.roll && a.speed === b.speed
{
  const flat = flatField(GROUND)
  const site = homeSite(1234)
  const d = dragonsOn(flat, [site], makeHerd([]))
  const t0 = chapterOf(1000, keyOf(site)).start
  d.update(HER.x, HER.y, HER.z, t0)
  const dr = d.byKey.get(keyOf(site))
  const nest = dr.site
  check(dr && d.byKey.size === 1 && d.free.length === MAX - 1 && nest.key === site.key && Math.abs(Math.hypot(nest.x - site.x, nest.z - site.z) - 0.75 * site.r) < 1e-9 && nest.y === site.y, 'the frame a site is listed a dragon is born to it, keyed by the roost\'s tile, its own half of the floor three quarters of a radius off the centre')
  check(dr.state === 'roost' && Math.abs(dr.x - nest.x) < 1e-9 && Math.abs(dr.z - nest.z) < 1e-9 && dr.y === nest.y && dr.clip === 'idle', 'born on its half of the nest at the chapter\'s turn, standing on the floor, idling', `y ${fmt(dr.y)} over ${fmt(nest.y)}`)
  check(Math.abs(dr.size / wyvern.sizeM - 1) <= SIZE_VARY && Math.abs(dr.k - dr.size / wyvern.span) < 1e-12 && Math.abs(dr.lodSize - dr.size * d.bulk) < 1e-12, `sized within ${SIZE_VARY * 100}% of the roster, the ladder sized by the flying bulk`, `${fmt(dr.size)} m, lod size ${fmt(dr.lodSize)}`)
  check(dr.lod === 0 && dr.puppet && dr.rec.tick === tickOf(t0), 'wearing a puppet with her beside the nest, stepped to the clock\'s tick')
  const twin = dragonsOn(flat, [site], makeHerd([]), 3)
  twin.update(HER.x, HER.y, HER.z, t0 + 250)
  const tw = twin.byKey.get(keyOf(site))
  check(tw.size === dr.size && tw.home.heading === dr.home.heading, 'the same nest holds the same dragon every visit: its size and its home heading are the roost\'s seed')

  const ch = d.score.chapter(keyOf(site), t0)
  const ph = ch.phrases
  const sum = ph.reduce((s, p) => s + p.dur, 0)
  check(ch.start === t0 && Math.abs(sum - CHAPTER_S) < 1e-6 && ph.every((p) => p.dur > 0), `the chapter is ${ph.length} phrases whose durations sum to CHAPTER_S ${CHAPTER_S} s exactly`, `${fmt(sum)} s`)
  check(ph[0].kind === 'rest' && ph[0].at === nest && ph[0].from === dr.home && ph[ph.length - 1].to === dr.home && ph[ph.length - 1].kind === 'rest', 'it opens with a rest on the nest from the home pose and closes with one ending at it')
  check(ph.every((p, i) => i === 0 || p.from === ph[i - 1].to), 'every phrase starts from the object the one before ends at: one chain, no two poses to disagree')
  check(ph.every((p) => Number.isFinite(p.to.speed) && (p.kind === 'fly' ? p.to.speed === p.mps * LOITER_PACE : p.to.speed === 0)), 'every end pose carries the speed the body arrives at: LOITER_PACE of the leg\'s cruise in the air, nothing on the ground')
  const flies = ph.filter((p) => p.kind === 'fly')
  const lands = ph.map((p, i) => [p, i]).filter(([p]) => p.kind === 'land')
  check(flies.length >= 3 && flies.every((p) => Math.hypot(p.to.x - site.x, p.to.z - site.z) <= PATROL_M + LAND_M + 1e-6 && p.to.y > GROUND + MIN_AGL), `the legs end within PATROL_M + LAND_M of the nest and well over the ground`, `${flies.length} legs`)
  check(lands.length >= 1 && lands.every(([p, i]) => ph[i - 1].kind === 'fly' && ph[i - 1].dest === p.dest && ph[i + 1].kind === 'rest' && ph[i + 1].at === p.dest && Math.abs(p.to.y - p.dest.y) < 1e-9), 'every landing follows a leg to its floor and is followed by a rest on it, touching down on that floor')
  check(ph.some((p) => p.kind === 'rest' && p.at === nest && p !== ph[0] && p !== ph[ph.length - 1]) || ph.length <= 4, 'between flights it rests on the nest')
  const chapters = (dd, n) => Array.from({ length: n }, (_, c) => dd.score.chapter(keyOf(site), t0 + c * CHAPTER_S))
  const modes = new Set(chapters(d, 12).flatMap((c) => c.phrases.filter((p) => p.kind === 'fly').map((p) => p.mode)))
  check(modes.has('patrol') && modes.has('explore') && modes.has('return'), 'over a dozen chapters it patrols hungry and explores fed, and every flight returns', [...modes].join(' '))
  const budgets = chapters(d, 12).map((c) => c.phrases.filter((p) => p.kind !== 'rest' || p.at !== nest).reduce((s, p) => s + p.dur, 0))
  check(budgets.every((b) => b >= FLIGHT_MIN_S), `no chapter's flying, perches and all, is under FLIGHT_MIN_S ${FLIGHT_MIN_S} s`, budgets.map((b) => fmt(b)).join(' '))
  const strip = (c) => JSON.stringify(c.phrases.map((p) => [p.kind, p.dur, p.to, p.mode ?? '', p.at?.key === site.key || p.dest?.key === site.key ? 'home' : p.dest?.turf || p.at?.turf ? 'turf' : '']))
  check(chapters(d, 3).every((c, i) => strip(c) === strip(chapters(twin, 3)[i])), 'and another instance plans the same three chapters to the digit: the plan is a function of the key and the chapter alone')
  twin.dispose()
  d.dispose()
}

// --- a chapter flown on the room's clock: rests, legs, landings, no tick faster than its rates, no snap the eye reads ---
{
  const flat = flatField(GROUND)
  const site = homeSite(1234)
  const d = dragonsOn(flat, [site], makeHerd([]))
  const t0 = chapterOf(1000, keyOf(site)).start
  d.update(HER.x, HER.y, HER.z, t0)
  const dr = d.byKey.get(keyOf(site))
  const AIRBORNE = new Set(['patrol', 'explore', 'hunt', 'stoop', 'return', 'rejoin'])
  const worst = { turn: 0, pitch: 0, roll: 0, accel: 0, move: 0, under: Infinity, farFromHome: 0, banked: 0, snap: 0, snapTurn: 0, snapSpeed: 0, ticksPerFrame: 0, alphaOut: 0 }
  const seen = new Set()
  const trace = []
  let phrase = dr.phrase
  let tick = dr.rec.tick
  let cruised = 0
  const measure = () => {
    const ran = dr.rec.tick - tick
    tick = dr.rec.tick
    worst.ticksPerFrame = Math.max(worst.ticksPerFrame, ran)
    if (dr.rec.alpha < 0 || dr.rec.alpha > 1) worst.alphaOut++
    if (ran !== 1) return
    const speedWas = speed
    speed = dr.speed
    if (dr.phrase !== phrase) {
      // The tick that crossed a boundary: the pose before it is what the ease left, the phrase's end is what it was snapped to.
      worst.snap = Math.max(worst.snap, Math.hypot(dr.px - phrase.to.x, dr.py - phrase.to.y, dr.pz - phrase.to.z))
      worst.snapTurn = Math.max(worst.snapTurn, Math.abs(swing(dr.pheading, phrase.to.heading)))
      worst.snapSpeed = Math.max(worst.snapSpeed, Math.abs(speedWas - phrase.to.speed))
      phrase = dr.phrase
      return
    }
    worst.turn = Math.max(worst.turn, Math.abs(swing(dr.pheading, dr.heading)) / TICK_S)
    worst.pitch = Math.max(worst.pitch, Math.abs(dr.pitch - dr.ppitch) / TICK_S)
    worst.roll = Math.max(worst.roll, Math.abs(dr.roll - dr.proll) / TICK_S)
    worst.accel = Math.max(worst.accel, Math.abs(dr.speed - speedWas) / TICK_S)
    worst.move = Math.max(worst.move, Math.hypot(dr.x - dr.px, dr.y - dr.py, dr.z - dr.pz) / TICK_S)
    worst.banked = Math.max(worst.banked, Math.abs(dr.roll))
    if (AIRBORNE.has(dr.state)) { worst.under = Math.min(worst.under, dr.y - GROUND); if (dr.y - GROUND > MIN_AGL) cruised++ }
    worst.farFromHome = Math.max(worst.farFromHome, Math.hypot(dr.x - site.x, dr.z - site.z))
  }
  let speed = dr.speed
  const FRAMES = 60 * CHAPTER_S
  for (let i = 1; i <= FRAMES; i++) {
    const now = t0 + i / 60
    d.update(HER.x, HER.y, HER.z, now)
    measure()
    if (!seen.has(dr.state)) { seen.add(dr.state); trace.push(`${dr.state}@${((i / 60)).toFixed(0)}s`) }
    if (d.stats.behind) throw new Error(`fell behind the clock at frame ${i}`)
  }
  check(seen.has('roost') && (seen.has('patrol') || seen.has('explore')) && seen.has('return') && seen.has('land') && !seen.has('menace'), 'through the chapter it rests, flies out, returns and lands, never live', trace.join(' '))
  check(worst.ticksPerFrame === 1 && worst.alphaOut === 0, 'at 60 Hz no frame runs more than one tick, and the frame\'s blend between ticks stays in [0, 1]')
  check(worst.turn <= Math.max(TURN_RATE, LAND_TURN_RATE, WALK_TURN_RATE) + EASE_TURN + 1e-6, 'no tick turned the body faster than its turn rate plus the ease\'s', `${fmt(worst.turn)} rad/s`)
  check(worst.pitch <= 2 * PITCH_RATE + 1e-6 && worst.roll <= 2 * ROLL_RATE + 1e-6, 'nor pitched or banked it faster than its rates plus the ease\'s', `pitch ${fmt(worst.pitch)} roll ${fmt(worst.roll)} rad/s`)
  check(worst.accel <= Math.max(ACCEL, STRIDE_ACCEL * dr.k) + ACCEL + 1e-6, 'nor changed its speed faster than ACCEL, or STRIDE_ACCEL on foot, plus the ease\'s', `${fmt(worst.accel)} m/s per s`)
  check(worst.move <= PATROL_MPS + Math.sqrt(3) * EASE_MPS + 1e-6, 'nor moved it faster than the cruise plus the ease\'s pull', `${fmt(worst.move)} m/s`)
  check(worst.snap < 1 && worst.snapTurn < 0.2 && worst.snapSpeed < 1, 'at every phrase boundary the ease had the body within a metre, a fifth of a radian and a metre a second of the planned end, so the snap onto it is nothing the eye reads', `worst ${fmt(worst.snap)} m, ${fmt(worst.snapTurn)} rad, ${fmt(worst.snapSpeed)} m/s`)
  check(worst.under > 0.1 && cruised > 60 * 20, `in the air it was never under the ground and cruised above MIN_AGL ${MIN_AGL} m for most of its flying`, `lowest ${fmt(worst.under)} m, ${cruised} ticks high`)
  check(worst.farFromHome < PATROL_M + LAND_M + 50, `and never strayed much past ${PATROL_M} m from the nest`, `${fmt(worst.farFromHome)} m at most`)
  check(worst.banked > 0.3 && worst.banked <= BANK + 1e-9, `it banked into its turns, never past ${BANK} rad`, `${fmt(worst.banked)} rad at most`)
  check(dr.x === dr.home.x && dr.y === dr.home.y && dr.z === dr.home.z && dr.heading === dr.home.heading && dr.speed === 0 && dr.state === 'roost' && dr.chapter === chapterOf(t0, keyOf(site)).index + 1, 'at the chapter\'s turn it is exactly at its home pose, on the next chapter\'s first rest', `chapter ${dr.chapter}`)
  d.dispose()
}

// --- in the air it is always flying forward: never hanging still on its wings, at a leg's end or anywhere else ---
{
  const flat = flatField(GROUND)
  const sites = [1234, 77, 4242, 9001].map(homeSite)
  let slowest = Infinity, where = '', ticks = 0
  for (const site of sites) {
    const d = dragonsOn(flat, [site], makeHerd([]))
    const t0 = chapterOf(1000, keyOf(site)).start
    d.update(HER.x, HER.y, HER.z, t0)
    const dr = d.byKey.get(keyOf(site))
    // The move along where the body points, over the last WINDOW ticks in the air: a hitch of a tick at a phrase's snap is not a hover, half a second still is.
    const WINDOW = 10
    const moves = []
    let flying = false
    for (let k = 1; k <= 4 * CHAPTER_S / TICK_S; k++) {
      const now = t0 + k * TICK_S
      d.update(HER.x, HER.y, HER.z, now)
      const ph = dr.phrase
      if (!(ph.kind === 'fly' || ph.kind === 'stoop' || (ph.kind === 'land' && !dr.down))) { moves.length = 0; flying = false; continue }
      // A take-off from the floor is slow until it is flying.
      if (!flying && dr.speed < LAND_MPS) continue
      flying = true
      moves.push(((dr.x - dr.px) * Math.cos(dr.heading) - (dr.z - dr.pz) * Math.sin(dr.heading)) * Math.cos(dr.pitch) + (dr.y - dr.py) * Math.sin(dr.pitch))
      if (moves.length > WINDOW) moves.shift()
      if (moves.length < WINDOW) continue
      ticks++
      const mps = moves.reduce((s, m) => s + m, 0) / (WINDOW * TICK_S)
      if (mps < slowest) { slowest = mps; where = `${ph.kind} ${ph.mode ?? ''} ${fmt(now - dr.phraseStart)} of ${fmt(ph.dur)} s` }
    }
    d.dispose()
  }
  check(ticks > 1000 && slowest >= LAND_MPS * 0.9, `over four chapters at four nests, every half second in the air carries the body forward at LAND_MPS ${LAND_MPS} m/s or near it -- it never hangs still on its wings`, `slowest ${fmt(slowest)} m/s (${where}), ${ticks} ticks`)
}

// --- determinism: two clients on different frame times agree to the bit at every tick, and a late joiner catches up to the same ---
{
  const flat = flatField(GROUND)
  const site = homeSite(1234)
  const t0 = chapterOf(1000, keyOf(site)).start
  const A = dragonsOn(flat, [site], makeHerd([]))
  const B = dragonsOn(flat, [site], makeHerd([]))
  A.update(HER.x, HER.y, HER.z, t0)
  B.update(HER.x + 300, HER.y, HER.z, t0)
  const a = A.byKey.get(keyOf(site)), b = B.byKey.get(keyOf(site))
  const poses = new Map([[a.rec.tick, pose(a)]])
  let differ = 0, compared = 0, multi = 0
  const END = t0 + CHAPTER_S + 30
  for (let i = 1; i <= 60 * (CHAPTER_S + 330); i++) { A.update(HER.x, HER.y, HER.z, t0 + i / 60); poses.set(a.rec.tick, pose(a)) }
  let tB = t0
  let jitter = 0.37
  while (tB < END) {
    jitter = (jitter * 9301 + 49297) % 233280
    // B's frames run 5 to 125 ms, so some carry no tick and some carry two.
    tB += 0.005 + 0.12 * (jitter / 233280)
    const was = b.rec.tick
    B.update(HER.x + 300, HER.y, HER.z, tB)
    if (b.rec.tick - was > 1) multi++
    const ref = poses.get(b.rec.tick)
    if (ref) { compared++; if (!samePose(ref, pose(b))) differ++ }
  }
  check(compared > 60 * CHAPTER_S / 4 && multi > 100 && differ === 0, 'a client at 60 Hz beside the nest and one on jittery frames 300 m off agree on the pose at every tick to the last bit, through a whole chapter', `${compared} ticks compared, ${multi} frames of two ticks or more, ${differ} differ`)
  // A joiner mid-chapter: placed at its phrase's start pose and replayed, no more than CATCH_UP_TICKS a frame, to the same tick pose.
  const tj = t0 + 200
  const C = dragonsOn(flat, [site], makeHerd([]))
  let frames = 0, replayed = 0, overBudget = 0
  do {
    C.update(HER.x, HER.y, HER.z, tj)
    frames++
    replayed += C.stats.replayed
    if (C.stats.replayed > CATCH_UP_TICKS) overBudget++
  } while (C.stats.behind && frames < 100)
  const c = C.byKey.get(keyOf(site))
  check(!C.stats.behind && frames >= 1 && overBudget === 0 && replayed <= CHAPTER_S * 20, `born 200 s into the chapter it replays its phrase from the start, at most CATCH_UP_TICKS ${CATCH_UP_TICKS} a frame, and is caught up`, `${replayed} ticks over ${frames} frames, ${c.state}`)
  check(c.rec.tick === tickOf(tj) && samePose(poses.get(c.rec.tick), pose(c)), 'and stands where the resident stood at that tick, to the bit', `${c.state} at (${fmt(c.x)}, ${fmt(c.y)}, ${fmt(c.z)})`)
  let cDiffer = 0
  for (let i = 1; i <= 60 * 300; i++) {
    C.update(HER.x, HER.y, HER.z, tj + i / 60)
    if (!samePose(poses.get(c.rec.tick), pose(c))) cDiffer++
  }
  check(cDiffer === 0 && c.rec.tick === tickOf(tj + 300), 'and stays with the resident to the bit for the five minutes after, across every boundary between', `${cDiffer} ticks differ`)
  // A joiner deep into a long phrase: the replay spans frames, and no frame takes the lag for a clock skip and starts it over.
  let tl = null
  for (let t = t0 + 30; t < t0 + CHAPTER_S - 30 && tl === null; t += 5) if (t - A._phraseAt(a, t).start > (CATCH_UP_TICKS * 3) * TICK_S) tl = t
  check(tl !== null, 'there is a moment in the chapter more than three catch-ups into its phrase', tl === null ? 'none' : `${fmt(tl - A._phraseAt(a, tl).start)} s in`)
  if (tl !== null) {
    const L = dragonsOn(flat, [site], makeHerd([]))
    let lFrames = 0, lReplayed = 0
    do { L.update(HER.x, HER.y, HER.z, tl); lFrames++; lReplayed += L.stats.replayed } while (L.stats.behind && lFrames < 100)
    const l = L.byKey.get(keyOf(site))
    check(!L.stats.behind && lFrames >= 4 && lReplayed === tickOf(tl) - tickAfter(A._phraseAt(a, tl).start) + 1, 'born there it catches up over several frames, replaying the phrase exactly once', `${lReplayed} ticks over ${lFrames} frames`)
    check(l.rec.tick === tickOf(tl) && samePose(poses.get(l.rec.tick), pose(l)), 'and stands where the resident stood at that tick, to the bit')
    L.dispose()
  }
  // A clock skip (+5 h is 300 s on the room's clock): the gap is not replayed, the dragon is put on its score where the resident is, and the resident's ticks it replays are its current phrase's alone.
  const D = dragonsOn(flat, [site], makeHerd([]))
  const ts = t0 + 100
  for (let i = 0; i <= 60 * 50; i++) D.update(HER.x, HER.y, HER.z, ts + i / 60)
  const d = D.byKey.get(keyOf(site))
  const skipTo = ts + 50 + 300
  const sinceStart = tickOf(skipTo) - tickAfter(D._phraseAt(d, skipTo).start) + 1
  let sFrames = 0, sReplayed = 0, sOver = 0
  do {
    D.update(HER.x, HER.y, HER.z, skipTo)
    sFrames++
    sReplayed += D.stats.replayed
    if (D.stats.replayed > CATCH_UP_TICKS) sOver++
  } while (D.stats.behind && sFrames < 100)
  check(!D.stats.behind && sOver === 0 && sReplayed <= sinceStart && sReplayed < 6000, `a 300 s clock skip replays no more than the current phrase, at most CATCH_UP_TICKS a frame, never the gap`, `${sReplayed} ticks over ${sFrames} frames, the phrase ${sinceStart} ticks in`)
  check(d.rec.tick === tickOf(skipTo) && samePose(poses.get(d.rec.tick), pose(d)), 'and lands the dragon where the resident stands at that tick, to the bit', `${d.state} at (${fmt(d.x)}, ${fmt(d.y)}, ${fmt(d.z)})`)
  A.dispose(); B.dispose(); C.dispose(); D.dispose()
}

// --- the hunt: a hungry flight takes a stag off the wildlife's own score, the strike one closed-form fact both layers and every client agree on ---
{
  const flat = flatField(GROUND)
  const site = { ...homeSite(1234), tx: 0, tz: 0 }
  const herdOf = () => makeHerd([stag(120, 60, GROUND, 'st:3,1:0'), stag(-90, 40, GROUND, 'st:-3,1:1'), stag(600, 0, GROUND, 'st:18,0:0')])
  const herd = herdOf()
  const d = dragonsOn(flat, [site], herd)
  check(typeof herd.hunter === 'function', 'born, the layer hangs itself on the wildlife as its hunter')
  const key = keyOf(site)
  const t0 = chapterOf(1000, key).start
  let ch = null, at = -1
  for (let c = 0; c < 12 && !ch; c++) {
    const cc = d.score.chapter(key, t0 + c * CHAPTER_S)
    const i = cc.phrases.findIndex((p) => p.kind === 'stoop')
    if (i >= 0) { ch = cc; at = i }
  }
  check(ch !== null, 'within a dozen chapters a hungry flight hunts', ch ? `chapter ${ch.index}, phrase ${at}` : 'none')
  const ph = ch.phrases
  const [hunt, stoop, back, land, meal] = ph.slice(at - 1, at + 4)
  const strip = (c) => JSON.stringify(c.phrases.map((p) => [p.kind, p.dur, p.to, p.mode ?? '', p.prey ?? '', p.kill ?? '']))
  const prey = herd.stags.find((c) => c.key === stoop.prey)
  check(prey && prey.key !== 'st:18,0:0' && Math.hypot(prey.x - site.x, prey.z - site.z) <= HUNT_M && herd.rosterCalls > 0, `the stag is one of the roster within HUNT_M ${HUNT_M} m of the nest, never the one 600 m off`, stoop.prey)
  check(hunt.kind === 'fly' && hunt.mode === 'hunt' && hunt.mps === HUNT_MPS && Math.abs(Math.hypot(hunt.to.x - prey.x, hunt.to.z - prey.z) - STOOP_M) < 1e-9 && Math.abs(hunt.to.y - (prey.y + STOOP_AGL)) < 1e-9 && hunt.to === stoop.from, `the hunt leg flies at HUNT_MPS ${HUNT_MPS} m/s to STOOP_M ${STOOP_M} m short of and STOOP_AGL ${STOOP_AGL} m over where the stag's own plan has it`)
  check(Math.abs(stoop.to.x - prey.x) < 1e-9 && Math.abs(stoop.to.z - prey.z) < 1e-9 && Math.abs(stoop.to.y - (prey.y + STRIKE_AGL)) < 1e-9 && stoop.dur > 1 && stoop.dur < 10 && stoop.to.speed === HUNT_MPS && Math.abs(swing(stoop.to.heading, Math.atan2(-(stoop.to.z - stoop.from.z), stoop.to.x - stoop.from.x))) < 1e-9, `the stoop ends STRIKE_AGL ${STRIKE_AGL} m over the stag at the hunt's pace, headed along the dive`, `${fmt(stoop.dur)} s`)
  const struck = back.kill?.struck
  check(back.kind === 'fly' && back.mode === 'return' && back.from === stoop.to && back.kill && back.kill.prey === prey.key && Math.abs(struck - (ch.start + ch.starts[at] + stoop.dur)) < 1e-6 && land.kind === 'land' && land.kill === back.kill && meal.kind === 'rest' && meal.meal === true && meal.kill === back.kill && !meal.at.turf, 'the return leg, the landing and the rest on the nest carry the kill: the stag, and the strike, which is the stoop\'s end')
  const stoops = ph.map((p, i) => [p, i]).filter(([p]) => p.kind === 'stoop')
  check(stoops.every(([p, i]) => ph[i - 1].mode === 'hunt' && ph[i + 1].mode === 'return' && ph[i + 2].kind === 'land' && ph[i + 3].meal && ph[i + 3].dur >= MEAL_S) && ph.filter((p) => p.kill).length === 3 * stoops.length && ph.filter((p) => p.kind === 'rest' && p.meal).length === stoops.length, `every stoop follows its hunt leg and is followed by the return, the landing and a meal of MEAL_S ${MEAL_S} s at least, and nothing else carries a kill`, `${stoops.length} hunts`)
  check(d.strikeOn(prey.key, ch.start, ch.start + CHAPTER_S) === struck && herd.hunter(prey.key, struck - 1, struck + 1) === struck && d.strikeOn(prey.key, struck + 1e-6, struck + 100) === null && d.strikeOn('st:18,0:0', ch.start, ch.start + CHAPTER_S) === null, 'strikeOn answers the strike for any window holding it, none for a window past it, and none for the stag out of reach')
  // Its GLB not landed either: the wildlife asks strikeOn as soon as its own bodies land, which can be first.
  const twin = Object.assign(dragonsOn(flat, [site], herdOf()), { asset: undefined, fly: undefined })
  check(twin.strikeOn(prey.key, ch.start, ch.start + CHAPTER_S) === struck && twin.byKey.size === 0 && strip(twin.score.chapter(key, ch.start)) === strip(ch), 'another client, its dragon never born and its GLB not landed, plans the same hunt to the digit from the roost\'s tile and answers the same strike')
  twin.dispose()

  d.update(HER.x, HER.y, HER.z, ch.start)
  const dr = d.byKey.get(key)
  const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  const seen = []
  let now = ch.start, nearest = Infinity, deepest = 0, stooped = 0, returnedEmpty = 0, ateAt = -1
  const mealStart = ch.start + ch.starts[at + 3]
  while (now < mealStart + meal.dur) {
    now += DT
    d.update(HER.x, HER.y, HER.z, now)
    if (seen[seen.length - 1] !== dr.state) seen.push(dr.state)
    if (dr.state === 'stoop') { stooped++; nearest = Math.min(nearest, gap(dr, stoop.to)); deepest = Math.min(deepest, dr.pitch) }
    if ((dr.state === 'return' || dr.state === 'land') && dr.cargo !== prey) returnedEmpty++
    if (now > mealStart && dr.state === 'roost' && !dr.cargo && ateAt < 0) ateAt = now - mealStart
  }
  const order = ['hunt', 'stoop', 'return', 'land', 'roost'].map((st) => seen.lastIndexOf(st))
  check(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), 'flown, it hunts, stoops, returns, lands and roosts, in that order', seen.join(' '))
  check(stooped > 20 && deepest < -0.5 && nearest < 3, 'the stoop is a dive, pitched down past half a radian, that brings the body within 3 m of the strike before the boundary snaps it there', `${stooped} ticks, pitch ${fmt(deepest)}, nearest ${fmt(nearest)} m`)
  check(prey.killed.length === 1 && prey.killed[0] === struck && prey.seized === 1 && returnedEmpty === 0 && prey.carried > 0 && prey.lainFrames > 0, 'at the stoop\'s end the stag is killed at the strike time, in the talons the whole way home, and laid on the nest')
  check(ateAt > 0 && prey.drops.join() === 'true' && dr.cargo === null, 'and eaten on the nest: dropped to fade when the meal ends', `${fmt(ateAt)} s into the rest`)

  const J = dragonsOn(flat, [site], herdOf())
  const tj = ch.start + ch.starts[at + 1] + back.dur / 2
  for (let i = 0; i < 100; i++) { J.update(HER.x, HER.y, HER.z, tj); if (!J.stats.behind) break }
  const j = J.byKey.get(key)
  const jprey = J.wildlife.stags.find((c) => c.key === prey.key)
  check(j.state === 'return' && j.cargo === jprey && jprey.killed.join() === String(struck) && !J.stats.behind, 'a client joining mid-return finds the kill in the talons, taken at the strike time')
  const turn = chapterOf(struck, prey.key).start + CHAPTER_S
  j.cargo = null
  J._enter(j, { phrase: back, start: ch.start + ch.starts[at + 1], end: ch.start + ch.starts[at + 2], index: at + 1, chapter: ch.index, rejoin: false }, turn)
  check(j.cargo === null && jprey.killed.length === 1, 'entered once the stag\'s chapter has turned, the leg takes no kill: the stag is on its feet again and the dragon flies home with nothing')
  J.dispose()
  d.dispose()
}

// --- the meal: a kill on the nest is laid at one spot, walked round and eaten, and a fed dragon potters ---
{
  const flat = flatField(GROUND)
  const site = homeSite(1234)
  const stags = [stag(120, 60)]
  const d = dragonsOn(flat, [site], makeHerd(stags))
  d.plan = restPlan(d)
  const t0 = chapterOf(1000, keyOf(site)).start
  let now = t0
  const step = () => { now += DT; d.update(HER.x, HER.y, HER.z, now) }
  d.update(HER.x, HER.y, HER.z, now)
  const dr = d.byKey.get(keyOf(site))
  check(dr.phrase.kind === 'rest' && dr.phrase.dur === 300 && d.score.chapter(keyOf(site), t0).phrases.length === 2, 'a gate may lay its own chapter under a dragon: two rests of 300 s here')
  // The kill laid on the nest by hand, as the hunt will lay it.
  dr.cargo = stags[0]
  d._meal(dr)
  const walkMps = wyvern.gait.walk * dr.k
  const nest = { moved: 0, walkFast: 0, offFloor: 0, killMoved: 0, farthest: 0, headings: 0, eatAt: -1, ateAt: -1, eatFacing: Infinity, eatFrom: Infinity, clips: new Set() }
  let cargoFrames = 0, lastHeading = dr.heading, tick = dr.rec.tick
  step()
  const kill = { x: stags[0].x, z: stags[0].z }
  const spot = dr.site, ahead = { x: spot.x + Math.cos(dr.home.heading) * EAT_REACH * dr.k, z: spot.z - Math.sin(dr.home.heading) * EAT_REACH * dr.k }
  check(Math.hypot(kill.x - ahead.x, kill.z - ahead.z) < 1e-9 && Math.abs(stags[0].y - site.y) < 1e-6 && stags[0].lain === true, 'the kill is laid on the nest floor EAT_REACH ahead of the dragon\'s own spot, on its flank', `at (${fmt(kill.x)}, ${fmt(kill.z)})`)
  for (let i = 0; i < 60 * 240 && nest.ateAt < 0; i++) {
    step()
    if (dr.cargo) cargoFrames++
    nest.clips.add(dr.clip)
    if (dr.rec.tick !== tick) {
      tick = dr.rec.tick
      nest.moved += Math.hypot(dr.x - dr.px, dr.z - dr.pz)
      if (dr.speed > walkMps * 1.001) nest.walkFast++
      if (Math.abs(dr.y - site.y) > 1e-6) nest.offFloor++
      if (dr.state !== 'roost') throw new Error(`left the nest mid-meal: ${dr.state}`)
    }
    nest.headings += Math.abs(swing(lastHeading, dr.heading)); lastHeading = dr.heading
    nest.farthest = Math.max(nest.farthest, Math.hypot(dr.x - spot.x, dr.z - spot.z))
    if (dr.cargo && (Math.abs(stags[0].x - kill.x) > 1e-9 || Math.abs(stags[0].z - kill.z) > 1e-9)) nest.killMoved++
    if (dr.rest === 'eat' && nest.eatAt < 0) nest.eatAt = now - t0
    if (dr.rest === 'eat') {
      nest.eatFacing = Math.min(nest.eatFacing, Math.abs(swing(dr.heading, Math.atan2(-(kill.z - dr.z), kill.x - dr.x))))
      nest.eatFrom = Math.hypot(kill.x - dr.x, kill.z - dr.z)
    }
    if (!dr.cargo && nest.ateAt < 0) nest.ateAt = now - t0
  }
  check(nest.eatAt > 5 && nest.eatAt < 120, 'the dragon walks a circuit of the nest before it eats', `eating from ${fmt(nest.eatAt)} s`)
  check(nest.moved > 1.5 * site.r && nest.headings > Math.PI && nest.farthest < site.r, 'the circuit walked more than a radius and a half and turned more than a half turn, all of it on its half of the floor', `${fmt(nest.moved)} m, ${fmt(nest.headings)} rad, ${fmt(nest.farthest)} m out at most`)
  check(nest.walkFast === 0 && nest.offFloor === 0, 'and never moved faster than the shipped walk gait at its size nor left the floor plane', `walk ${fmt(walkMps)} m/s; ${nest.walkFast} fast ticks, ${nest.offFloor} off the floor`)
  check(nest.killMoved === 0, 'the kill lay where it was laid through the whole circuit: it does not follow the dragon round')
  check(nest.eatFacing < 0.1 && Math.abs(nest.eatFrom - EAT_REACH * dr.k) < WAY * dr.k, `eating, it faces the kill with the kill ${fmt(EAT_REACH * dr.k)} m ahead, where the eat clip's snout plunges`, `off by ${fmt(nest.eatFacing)} rad, ${fmt(nest.eatFrom)} m`)
  check(nest.ateAt > 0 && nest.ateAt - nest.eatAt >= EAT_S[0] - 0.1 && nest.ateAt - nest.eatAt <= EAT_S[1] + 0.1 && stags[0].drops.join() === 'true' && dr.cargo === null && d.stats.carrying === 0, `after ${EAT_S[0]} to ${EAT_S[1]} s of eating the carcass is gone -- dropped to fade -- and the dragon carries nothing`, `ate for ${fmt(nest.ateAt - nest.eatAt)} s`)
  check(stags[0].carried === cargoFrames + 1 && cargoFrames > 60 && Math.abs(stags[0].carryDt - DT) < 1e-9, 'wildlife.carry was called on every frame it was cargo, with the frame', `${cargoFrames} frames`)
  check(stags[0].shownFrames === stags[0].carried && stags[0].lainFrames === stags[0].carried, 'and told the dragon was drawn on every one of them, the kill lying on its flank on every one')
  check(Math.abs(dr.roll) < 1e-9 && Math.abs(dr.pitch) < 1e-9, 'standing level')
  // Fed, it potters: several kinds of step, walks among them, and no eating with nothing to eat.
  const potter = { clips: new Set(), walked: 0 }
  for (let i = 0; i < 60 * 60; i++) {
    step()
    potter.clips.add(dr.clip)
    if (dr.rest === 'walk') potter.walked += DT
  }
  check(dr.state === 'roost' && potter.clips.size >= 3 && potter.walked > 5 && !potter.clips.has('eat') && !potter.clips.has('fly'), 'and does not just stand there: three kinds of step at least, walking among them, and no eating with nothing to eat', [...potter.clips].join(' ') + `, walked ${fmt(potter.walked)} s`)
  const listed = d.bodies([])
  check(listed.length === 1 && listed[0] === dr && typeof dr.cycle === 'number' && dr.cycle > 0, 'bodies() lists it for the ear with its clip\'s cycle')
  d.dispose()
}

// --- exploring: a fed dragon visits a spot away from the nest, perches and potters there, and flies on; steep or drowned ground it does not ---
{
  const flat = flatField(GROUND)
  const site = homeSite(4321)
  const t0 = chapterOf(1000, keyOf(site)).start
  /** The first landing on turf in the plan's first `n` chapters, with the world time it starts, or null. */
  const firstVisit = (dd, n = 12) => {
    dd.update(HER.x, HER.y, HER.z, t0)
    for (let c = 0; c < n; c++) {
      const ch = dd.score.chapter(keyOf(site), t0 + c * CHAPTER_S)
      const i = ch.phrases.findIndex((p) => p.kind === 'land' && p.dest.turf)
      if (i >= 0) return { start: ch.start + ch.starts[i], phrase: ch.phrases[i], perch: ch.phrases[i + 1] }
    }
    return null
  }
  const seek = dragonsOn(flat, [site], makeHerd([]), 8)
  const visit = firstVisit(seek)
  seek.dispose()
  check(visit !== null && visit.perch.kind === 'rest' && visit.perch.at === visit.phrase.dest && visit.perch.dur >= PERCH_S[0] - 1e-9 && visit.perch.dur <= PERCH_S[1] + 1e-9, `fed, within a dozen chapters it plans to alight on a spot away from the nest and perch ${PERCH_S[0]} to ${PERCH_S[1]} s`, visit ? `at ${fmt(visit.start - t0)} s, ${fmt(visit.perch.dur)} s perched` : 'never')
  const spot = visit.phrase.dest
  check(spot !== site && spot.turf === true && Math.hypot(spot.x - site.x, spot.z - site.z) >= SPOT_AWAY * site.r && Math.hypot(spot.x - site.x, spot.z - site.z) <= PATROL_M + 20, `the spot is turf ${SPOT_AWAY} nest radii or more from home and within the patrol's range`, `${fmt(Math.hypot(spot.x - site.x, spot.z - site.z))} m from the nest`)
  // A dragon born at the landing's start glides onto the spot and perches.
  const d = dragonsOn(flat, [site], makeHerd([]), 8)
  let now = visit.start
  d.update(HER.x, HER.y, HER.z, now)
  const dr = d.byKey.get(keyOf(site))
  check(dr.state === 'land' && dr.clip === 'fly' && dr.dest.turf === true && Math.abs(dr.y - (GROUND + 30)) < 1e-6, 'born at the landing\'s start it is on the approach, flying, over the spot', `${dr.state} at ${fmt(dr.y - GROUND)} m up`)
  const perch = { clips: new Set(), walked: 0, offGround: 0, off: 0, at: -1 }
  for (let i = 0; i < 60 * (visit.phrase.dur + visit.perch.dur + 1); i++) {
    now += DT
    d.update(HER.x, HER.y, HER.z, now)
    if (dr.state === 'perch') {
      if (perch.at < 0) perch.at = now - visit.start
      perch.clips.add(dr.clip)
      if (dr.rest === 'walk') perch.walked += DT
      if (now - visit.start > visit.phrase.dur + 3 && Math.abs(dr.y - GROUND) > 1e-6) perch.offGround++
      perch.off = Math.max(perch.off, Math.hypot(dr.x - spot.x, dr.z - spot.z))
    }
  }
  check(perch.at > 0 && perch.at <= visit.phrase.dur + 0.1, 'it is down and perched when the landing\'s clock says', `perched at ${fmt(perch.at)} s of a ${fmt(visit.phrase.dur)} s landing`)
  check(perch.clips.size >= 2 && perch.walked > 2 && perch.offGround === 0 && perch.off < site.r, 'perched, it potters as at home -- walking about, standing on the ground itself -- and stays about the spot', `${[...perch.clips].join(' ')}, walked ${fmt(perch.walked)} s, ${fmt(perch.off)} m out at most`)
  check(['explore', 'return'].includes(dr.state) && dr.clip === 'fly', 'and after the perch it flies on, or home if the flight has no more legs', dr.state)
  d.dispose()

  // The same landing with a boulder under the spot: the walker's ground stands STONE over the field's there, and the dragon perches and potters on its top.
  const STONE = 1.5
  const boulder = { heightAt: (x, z) => GROUND + (Math.hypot(x - spot.x, z - spot.z) < 40 ? STONE : 0) }
  const o = dragonsOn(flat, [site], makeHerd([]), 8, dry, Solo, boulder)
  now = visit.start
  o.update(HER.x, HER.y, HER.z, now)
  const on = { frames: 0, walked: 0, offStone: 0 }
  for (let i = 0; i < 60 * (visit.phrase.dur + visit.perch.dur + 1); i++) {
    now += DT
    o.update(HER.x, HER.y, HER.z, now)
    const ob = o.byKey.get(keyOf(site))
    if (ob.state !== 'perch' || now - visit.start <= visit.phrase.dur + 3) continue
    on.frames++
    if (ob.rest === 'walk') on.walked += DT
    if (Math.abs(ob.y - (GROUND + STONE)) > 1e-6) on.offStone++
  }
  check(on.frames > 60 && on.walked > 2 && on.offStone === 0, 'perched on a boulder it stands and walks on the stone\'s top, never through it to the field under', `${on.frames} frames, walked ${fmt(on.walked)} s, ${on.offStone} off the stone`)
  o.dispose()

  const never = (label, field, water = dry) => {
    const dd = dragonsOn(field, [site], makeHerd([]), 8, water)
    check(firstVisit(dd) === null, label)
    dd.dispose()
  }
  never('with every spot under water, a dozen chapters alight nowhere but the nest', flat, { isSubmerged: () => true })
  never(`nor on ground steeper than ${SPOT_SLOPE_DEG} degrees`, flatField(GROUND, Math.tan((SPOT_SLOPE_DEG + 5) * Math.PI / 180)))
}

// --- a nest on a hillside: the dragon stands on its floor and the kill lies on its plane ----
{
  const gx = 0.25, gz = -0.15
  const hill = hillField(GROUND, gx, gz)
  const site = { key: 31, tx: 31, tz: 0, x: 40, y: hill.heightAt(40, -20) - 0.06 * 4, z: -20, r: 4, gx, gz }
  const stags = [stag(500, 500)]
  const d = dragonsOn(hill, [site], makeHerd(stags))
  const t0 = chapterOf(1000, keyOf(site)).start
  d.update(HER.x, HER.y, HER.z, t0)
  const dr = d.byKey.get(keyOf(site))
  const nest = dr.site, nu = nest.x - site.x, nv = nest.z - site.z
  check(Math.abs(nest.y - (site.y + gx * nu + gz * nv)) < 1e-9 && dr.y === nest.y, 'born standing on its half of the tilted floor, at that plane\'s own height there')
  // The kill laid on this nest, by hand.
  dr.cargo = stags[0]
  d._meal(dr)
  d.update(HER.x, HER.y, HER.z, t0 + DT)
  const c = stags[0]
  const u = c.x - site.x, v = c.z - site.z
  const normal = new THREE.Vector3(-gx, 1, -gz).normalize()
  check(c.lain === true && Math.abs(Math.hypot(c.x - nest.x, c.z - nest.z) - EAT_REACH * dr.k) < 1e-9 && Math.abs(c.y - (site.y + gx * u + gz * v)) < 1e-9, 'a kill on this nest lies beside the dragon ON the tilted floor plane, at that plane\'s own height there, not at the centre\'s', `at (${fmt(u)}, ${fmt(v)}) off centre, y ${fmt(c.y)} for a floor of ${fmt(site.y + gx * u + gz * v)}`)
  check(c.up.distanceTo(normal) < 1e-9, 'and lies tilted with the floor, its up the nest plane\'s normal', `up (${fmt(c.up.x)}, ${fmt(c.up.y)}, ${fmt(c.up.z)})`)
  check((() => { try { dragonsOn(hill, [{ key: 32, tx: 32, tz: 0, x: 0, y: GROUND, z: 0, r: 4 }], makeHerd([])).update(0, 0, 0, t0); return false } catch (e) { return /floor plane/.test(e.message) } })(), 'a site with no floor plane is refused by name, not stood on at NaN')
  check((() => { try { d.update(0, 0, 0, NaN); return false } catch (e) { return /world time/.test(e.message) } })(), 'and a frame with no world time is refused: nothing about a dragon is timed from anything else')
  d.dispose()
}

// --- a fish in her hand: a roosting dragon drops its kill and comes off the nest at her, live; put away, it rejoins its score ----
{
  const flat = flatField(GROUND)
  const site = homeSite(78)
  const stags = [stag(500, 500)]
  const d = dragonsOn(flat, [site], makeHerd(stags), 5)
  d.plan = restPlan(d)
  const t0 = chapterOf(1000, keyOf(site)).start
  let now = t0
  // She stands east of the nest, the hand a metre up, and never moves her feet: the hand is what the dragon reads.
  const her = { x: 12, y: GROUND + 1.6, z: 0 }
  const hand = (kind, x, z = dr.site.z) => ({ kind, x, y: GROUND + 1, z })
  let turned = 0
  const frame = (lures) => { now += DT; const tick = dr.rec.tick; d.update(her.x, her.y, her.z, now, lures); if (dr.rec.tick !== tick) turned = Math.max(turned, Math.abs(swing(dr.pheading, dr.heading)) / TICK_S) }
  const run = (s, lures, seen) => { for (let i = 0; i < s * 60; i++) { frame(lures); if (seen) seen() } }
  /** Frames until one tick has run. */
  const tick = (lures) => { const t = dr.rec.tick; while (dr.rec.tick === t) frame(lures) }
  d.update(her.x, her.y, her.z, now)
  const dr = d.byKey.get(keyOf(site))
  const reach = (EAT_REACH + MENACE) * dr.k
  const gap = (l) => Math.hypot(l.x - dr.x, l.z - dr.z)
  // Out of reach, or the wrong thing: the dragon rests on.
  run(2, [hand('fish', dr.site.x + LURE * dr.k + 1)])
  check(dr.state === 'roost' && dr.lure === null && dr.live === null, `a fish ${fmt(LURE * dr.k + 1)} m off is not noticed`)
  run(2, [hand('carrot', dr.site.x + 2)])
  check(dr.state === 'roost' && dr.lure === null, 'nor is a carrot in reach', LURES.join(', '))
  // Eating its kill on the nest when the fish comes within reach: the kill is let go, and the dragon is up and alert.
  dr.cargo = stags[0]
  d._meal(dr)
  run(1, [])
  check(dr.state === 'roost' && dr.cargo === stags[0] && dr.queue.length > 0, 'settled on the nest with its kill, working through its circuit')
  const fish = hand('fish', dr.site.x + LURE * dr.k - 0.5)
  tick([fish])
  check(dr.state === 'menace' && dr.lure === fish && dr.live && dr.live.by === null && dr.cargo === null && stags[0].drops.join() === 'true' && dr.clip === 'alert' && dr.queue.length === 0, `a fish ${fmt(LURE * dr.k - 0.5)} m off has it drop the kill to fade and go LIVE to menace, alert, this client the authority`, `state ${dr.state}, clip ${dr.clip}, drops ${stags[0].drops.join()}`)
  // The stomp: at the walk gait inside MENACE_RUN, toward the hand, and stopped with its head at her, eating at her.
  turned = 0
  let walked = false
  let top = 0
  const x0 = dr.x
  run(6, [fish], () => { if (dr.clip === 'walk') walked = true; top = Math.max(top, dr.speed) })
  check(walked && top > wyvern.gait.walk * dr.k * 0.9 && top <= wyvern.gait.walk * dr.k + 1e-9 && dr.x > x0 + 0.5, 'it walks at the hand at the walk gait', `top ${fmt(top)} of ${fmt(wyvern.gait.walk * dr.k)} m/s, ${fmt(dr.x - x0)} m east`)
  // The stop is a deceleration at STRIDE_ACCEL from the walk, so the stance is that stopping distance short of reach.
  const brake = (wyvern.gait.walk * dr.k) ** 2 / (2 * STRIDE_ACCEL * dr.k)
  const stops = (l) => gap(l) < reach + 0.05 && gap(l) > reach - brake - 0.05
  const facing = (l) => Math.abs(swing(dr.heading, Math.atan2(-(l.z - dr.z), l.x - dr.x))) < 0.05
  check(dr.clip === 'eat' && dr.speed < 0.05 && stops(fish) && facing(fish), `and stops eating at her, its head EAT_REACH + MENACE ${fmt(reach)} m short of the hand, facing it`, `clip ${dr.clip}, ${fmt(gap(fish))} m off, heading ${fmt(dr.heading)}`)
  check(turned <= WALK_TURN_RATE + 1e-6, `never turning faster than WALK_TURN_RATE ${WALK_TURN_RATE} a tick`, `${fmt(turned)} rad/s`)
  check(dr.y >= GROUND && dr.y < GROUND + 0.05 * site.r && Math.abs(dr.pitch) < 1e-6 && Math.abs(dr.roll) < 1e-6, 'level, standing over the nest floor still', `y ${fmt(dr.y)}`)
  const anchors = d.pending()
  check(anchors.length >= 6 && anchors.length <= 8 && anchors.every((a) => a[0] === keyOf(site) && a[7] === 'menace' && a[8] === null && Number.isFinite(a[9]) && a[1] > t0) && anchors.every((a, i) => i === 0 || a[1] - anchors[i - 1][1] >= ANCHOR_S - 1e-9), `seven seconds live, the authority owes the room one menace anchor a second, none sooner than ANCHOR_S ${ANCHOR_S} s after the last, each carrying its speed`, `${anchors.length} anchors`)
  // A step back holds it; MENACE back has it after her again; and off past MENACE_RUN it runs.
  run(2, [hand('fish', fish.x + MENACE * dr.k * 0.5)])
  check(dr.clip === 'eat', `a half step back and it eats on`)
  const back = hand('fish', fish.x + MENACE * dr.k + brake + 0.3)
  run(0.2, [back])
  check(dr.clip === 'walk', `MENACE back and it is walking after her again`, dr.clip)
  run(3, [back])
  check(dr.clip === 'eat' && stops(back), 'to stop at her again', `${fmt(gap(back))} m off`)
  const far = hand('fish', dr.x + reach + MENACE_RUN * dr.k + 2)
  let ran = false
  top = 0
  run(8, [far], () => { if (dr.clip === 'run') { ran = true; top = Math.max(top, dr.speed) } })
  check(ran && top > wyvern.gait.run * dr.k * 0.9 && dr.state === 'menace', `the hand ${fmt(MENACE_RUN * dr.k + 2)} m past its head, it runs at the run gait`, `top ${fmt(top)} of ${fmt(wyvern.gait.run * dr.k)} m/s`)
  check(dr.clip === 'eat' && stops(far) && Math.abs(dr.y - GROUND) < 1e-6, 'and is at her again, on the ground off the nest', `${fmt(gap(far))} m off, y ${fmt(dr.y)}`)
  // Carried off at a quarter again its walk: it stomps after her in rushes, run and stop, never far off.
  const walk = hand('fish', far.x)
  let worst = 0
  let rushes = 0
  let running = false
  run(20, [walk], () => { walk.z -= 1.25 * wyvern.gait.walk * dr.k * DT; worst = Math.max(worst, gap(walk)); if (dr.clip === 'run') { if (!running) rushes++; running = true } else running = false })
  check(worst < reach + MENACE_RUN * dr.k + 1 && rushes >= 2 && rushes <= 5 && gap(walk) < reach + MENACE_RUN * dr.k + 1, 'carried off at her walk it stomps after her in rushes, run and stop, never far off', `never more than ${fmt(worst)} m off, ${rushes} rushes in 20 s, ${fmt(gap(walk))} m at the end`)
  // Kept to LURE_FORGET, given up past it: the rejoin, a leg home from here.
  tick([hand('fish', dr.x + LURE_FORGET * dr.k - 0.5, dr.z)])
  check(dr.state === 'menace', `a fish ${fmt(LURE_FORGET * dr.k - 0.5)} m off is still menaced`)
  d.pending()
  const left = { x: dr.x, y: dr.y, z: dr.z }
  tick([hand('fish', dr.x + LURE_FORGET * dr.k + 1, dr.z)])
  const rejoin = d.pending()
  check(dr.state === 'rejoin' && dr.live === null && dr.lure === null && dr.clip === 'fly' && dr.dest === dr.site && dr.rejoin && dr.rejoin.phrases.map((p) => p.kind).join(' ').match(/^(fly )?fly land rest$/), `and one ${fmt(LURE_FORGET * dr.k + 1)} m off is given up: it is on its rejoin -- a leg out if it is too near the nest to come round, a leg home, a landing and a rest -- flying`, `state ${dr.state}`)
  check(rejoin.length === 1 && rejoin[0][7] === 'rejoin' && rejoin[0][8] === null && Math.hypot(rejoin[0][2] - left.x, rejoin[0][4] - left.z) < 1 && Math.abs(rejoin[0][1] - now) < TICK_S, 'the authority owes the room one rejoin anchor, from where the lure ended and when', JSON.stringify(rejoin[0]?.map((v) => (typeof v === 'number' ? +v.toFixed(2) : v))))
  let frames = 0
  while (dr.state !== 'roost' && frames++ < 60 * 120) frame([])
  check(dr.state === 'roost' && Math.hypot(dr.x - dr.site.x, dr.z - dr.site.z) < site.r && dr.cargo === null && dr.rejoin !== null && dr.phrase.kind === 'rest' && Math.abs(dr.phraseEnd - dr.rejoin.end) < 1e-9, 'and is on its nest again, resting out the rejoin until the score\'s next rest on the nest', `${(frames / 60).toFixed(1)} s`)
  check(d.pending().length === 0, 'with nothing more sent')
  const rjEnd = dr.rejoin.end
  while (now < rjEnd + 1) frame([])
  check(dr.rejoin === null && dr.state === 'roost' && dr.phrase.kind === 'rest' && dr.phrase.at === dr.site && dr.x === dr.home.x && dr.z === dr.home.z, 'at that rest it is on the score again, at its home pose, the rejoin forgotten')
  // Put away in its face: given up at once, from the ground.
  const near = hand('fish', dr.x + reach, dr.z)
  run(3, [near])
  check(dr.state === 'menace' && dr.clip === 'eat', 'a fish put at its face on the nest is eaten at')
  tick([])
  check(dr.state === 'rejoin' && dr.live === null && d.pending().some((a) => a[7] === 'rejoin'), 'and put away, it is given up the same tick, the rejoin anchor owed')
  d.dispose()
}

// --- anchors: the lurer's client leads, a peer's follows its anchors, and a rejoin anchor puts every client on the same rejoin ----
{
  const flat = flatField(GROUND)
  const site = homeSite(78)
  const t0 = chapterOf(1000, keyOf(site)).start
  const born = (seed = 5) => { const dd = dragonsOn(flat, [site], makeHerd([]), seed); dd.plan = restPlan(dd); return dd }
  const A = born(), B = born()
  const her = { x: 12, y: GROUND + 1.6, z: 0 }
  let now = t0
  A.update(her.x, her.y, her.z, now)
  B.update(her.x, her.y, her.z, now)
  const a = A.byKey.get(keyOf(site)), b = B.byKey.get(keyOf(site))
  // The same fish, in A's own hand and, to B, in a peer's.
  const fish = { kind: 'fish', x: LURE * a.k - 0.5, y: GROUND + 1, z: 0 }
  const peerFish = { ...fish, by: 'peerA' }
  const both = (s, la, lb) => { for (let i = 0; i < s * 60; i++) { now += DT; A.update(her.x, her.y, her.z, now, la); B.update(her.x, her.y, her.z, now, lb) } }
  both(5, [fish], [peerFish])
  const fromA = A.pending(), fromB = B.pending()
  check(a.live && a.live.by === null && b.live && b.live.by === 'peerA' && fromA.length >= 5 && fromA.length <= 6 && fromB.length === 0, 'both menace the fish; the client whose hand it is publishes the anchors and the peer\'s client publishes none', `A ${fromA.length}, B ${fromB.length}`)
  check(samePose(pose(a), pose(b)), 'and, on the same hand, they agree to the bit without one')
  // The relay stamps who sent it; a client's own anchor coming back is ignored, a peer's is applied.
  B.apply(fromA[fromA.length - 1], now)
  check(B.anchored.size === 0 && b.live.anchor === null, 'an anchor with no sender is this client\'s own, and is ignored')
  const stamped = fromA.map((an) => { const s = an.slice(); s[8] = 'peerA'; return s })
  B.apply(stamped[stamped.length - 1], now)
  check(B.anchored.get(keyOf(site)) === stamped[stamped.length - 1] && b.live.anchor === stamped[stamped.length - 1] && b.live.by === 'peerA', 'a peer\'s anchor is kept and, its dragon live here, becomes the correction it is nudged onto')
  // The lure over on A: its rejoin anchor, applied on B, puts B's dragon on the same rejoin from the same pose and tick.
  both(0.2, [], [])
  const rj = A.pending().filter((an) => an[7] === 'rejoin')
  check(rj.length === 1 && a.state === 'rejoin' && b.state === 'menace' && b.clip === 'alert' && b.live.by === 'peerA', 'the fish put away, the lurer\'s client starts the rejoin and owes its anchor; the peer\'s, its anchor still fresh, stands alert at it waiting on that word', `A ${a.state}, B ${b.state} ${b.clip}`)
  const rjStamped = rj[0].slice(); rjStamped[8] = 'peerA'
  B.apply(rjStamped, now)
  check(b.state === 'rejoin' && b.live === null && b.rec.tick === tickOf(rj[0][1]) && b.rejoin.start === a.rejoin.start && b.rejoin.end === a.rejoin.end, 'the rejoin anchor applied puts B\'s dragon on the same rejoin, from the anchor\'s tick', `A tick ${a.rec.tick}, B tick ${b.rec.tick}`)
  let differ = 0, frames = 0
  while (a.state !== 'roost' && frames++ < 60 * 120) {
    both(DT, [], [])
    if (a.rec.tick === b.rec.tick && !samePose(pose(a), pose(b))) differ++
  }
  check(differ === 0 && a.state === 'roost' && b.state === 'roost' && samePose(pose(a), pose(b)) && b.rejoin && Math.abs(b.rejoin.end - a.rejoin.end) < 1e-9, 'and from there both fly the same rejoin home to the bit and rest until the same planned rest', `${differ} ticks differ`)
  // A client that meets the rejoin anchor before it has the dragon at all: born onto that rejoin, caught up to the same pose.
  const C = born()
  C.apply(rjStamped, now)
  check(C.anchored.get(keyOf(site)) === rjStamped && C.byKey.size === 0, 'a rejoin anchor for a dragon not yet born is kept for it')
  for (let i = 0; i < 100 && (C.byKey.size === 0 || C.stats.behind); i++) C.update(her.x, her.y, her.z, now)
  const c = C.byKey.get(keyOf(site))
  check(c && !C.stats.behind && c.rec.tick === a.rec.tick && samePose(pose(a), pose(c)) && c.state === 'roost' && c.rejoin && Math.abs(c.rejoin.end - a.rejoin.end) < 1e-9, 'and born, it is placed at the anchor, replays the rejoin from the anchor\'s time and stands where the others do, to the bit', `${c?.state} at tick ${c?.rec.tick}`)
  // A peer's live anchor with no hand in sight: stood alert at the anchor while it is fresh, the lure ended once it is stale.
  const D = born()
  D.update(her.x, her.y, her.z, now)
  const dd = D.byKey.get(keyOf(site))
  const late = stamped[stamped.length - 1].slice(); late[1] = now
  D.apply(late, now)
  D.update(her.x, her.y, her.z, now + TICK_S)
  check(dd.state === 'menace' && dd.live && dd.live.by === 'peerA' && dd.clip === 'alert' && D.pending().length === 0, 'a peer\'s live anchor puts the dragon here to menace, alert at the anchor, publishing nothing')
  D.update(her.x, her.y, her.z, now + ANCHOR_STALE_S + 0.1)
  check(dd.state === 'rejoin' && dd.live === null && D.pending().length === 0, `and with no hand in sight, ANCHOR_STALE_S ${ANCHOR_STALE_S} s after the anchor the lure ends here, on a rejoin, nothing owed`)
  check((() => { try { D.apply([keyOf(site), 1, 0, 0, 0, 0, -1, 'dance', 'peerA', 0], now); return false } catch (e) { return /anchor mode/.test(e.message) } })(), 'an anchor in a mode no dragon has is refused by name')
  A.dispose(); B.dispose(); C.dispose(); D.dispose()
}

// --- aggro on the ground: spotted near the nest, it turns, roars, charges, chomps her, growls, and gives her up far off ----
{
  const flat = flatField(GROUND)
  const site = homeSite(79)
  const d = dragonsOn(flat, [site], makeHerd([]), 5)
  d.plan = restPlan(d)
  let now = chapterOf(1000, keyOf(site)).start
  const spot = d._born(site, false).site
  const her = { x: spot.x + SPOT_M + 5, y: GROUND, z: spot.z, open: false, dead: false }
  const quarry = { her, striders: [] }
  let turned = 0
  const frame = () => { now += DT; const tick = dr.rec.tick; d.update(her.x, her.y + 1.6, her.z, now, [], quarry); if (dr.rec.tick !== tick) turned = Math.max(turned, Math.abs(swing(dr.pheading, dr.heading)) / TICK_S) }
  const run = (s, seen) => { for (let i = 0; i < s * 60; i++) { frame(); if (seen) seen() } }
  const until = (ok, s) => { for (let i = 0; i < s * 60 && !ok(); i++) frame(); return ok() }
  d.update(her.x, her.y + 1.6, her.z, now)
  const dr = d.byKey.get(keyOf(site))
  const snout = () => Math.hypot(her.x - dr.x - Math.cos(dr.heading) * EAT_REACH * dr.k, her.z - dr.z + Math.sin(dr.heading) * EAT_REACH * dr.k)
  run(2)
  check(dr.state === 'roost' && dr.live === null && dr.roarCue === 0, `her ${SPOT_M + 5} m off the resting dragon, it does not spot her`)
  her.x = spot.x + SPOT_M - 1
  until(() => dr.live !== null, 1)
  check(dr.state === 'aggro' && dr.live.phase === 'spot' && dr.live.prey === HER_ID && dr.live.by === null && dr.clip === 'alert' && dr.roarCue === 1, `her ${SPOT_M - 1} m off, it spots her: live, aggro, alert, one roar, this client steering`, `state ${dr.state}, phase ${dr.live?.phase}, roars ${dr.roarCue}`)
  until(() => dr.live.phase !== 'spot', SPOT_S + 0.1)
  const rate = CHARGE_MPS / (wyvern.gait.walk * dr.k)
  check(dr.live.phase === 'charge' && dr.clip === 'walk' && Math.abs(dr.rate - rate) < 1e-9 && Math.abs(dr.cycle - d.durations.walk / rate) < 1e-9, `SPOT_S ${SPOT_S} s later it charges, the walk sped to CHARGE_MPS`, `rate ${fmt(dr.rate)}`)
  let top = 0
  const x0 = dr.x
  until(() => { top = Math.max(top, dr.speed); return dr.live.phase === 'chomp' }, 8)
  check(top > 0.9 * CHARGE_MPS && top <= CHARGE_MPS + 1e-9 && dr.x > x0 + 1, `it charges at her at CHARGE_MPS ${CHARGE_MPS} m/s`, `top ${fmt(top)} m/s, ${fmt(dr.x - x0)} m east`)
  check(dr.live.phase === 'chomp' && dr.clip === 'eat' && snout() <= BITE_M + 0.1, `and chomps once its snout is within BITE_M ${BITE_M} m of her`, `${fmt(snout())} m`)
  check(turned <= WALK_TURN_RATE + 1e-6, `never turning faster than WALK_TURN_RATE ${WALK_TURN_RATE}`, `${fmt(turned)} rad/s`)
  run(BITE_AT_S + 0.1)
  check(d.hurt.length === 1 && d.hurt[0][0] === BITE_HP, `BITE_AT_S ${BITE_AT_S} s in, the bite hurts her ${BITE_HP} HP`, JSON.stringify(d.hurt))
  until(() => dr.live.phase !== 'chomp', CHOMP_S)
  check(dr.live.phase === 'growl' && dr.growlCue === 1 && dr.clip === 'alert' && dr.speed < 0.05, 'then it stands and growls', `phase ${dr.live.phase}, growls ${dr.growlCue}`)
  until(() => dr.live.phase !== 'growl', GROWL_S + 0.1)
  check(dr.live.phase === 'chomp', `GROWL_S ${GROWL_S} s on, her still in reach, it chomps again`, dr.live.phase)
  // Stepped back past HURT_M as the jaws come: the chomp misses, and the growl over, it charges again.
  const r = snout()
  her.x += HURT_M + 0.5 - r
  until(() => dr.live.phase === 'growl', CHOMP_S + 0.1)
  check(d.hurt.length === 1, `with her ${fmt(snout())} m from its snout, past HURT_M ${HURT_M} m, the chomp misses`, `${d.hurt.length} bites`)
  until(() => dr.live.phase !== 'growl', GROWL_S + 0.1)
  check(dr.live.phase === 'charge', 'and past BITE_M it charges again', dr.live.phase)
  const anchors = d.pending()
  check(anchors.length > 0 && anchors.every((a) => a[7] === 'aggro' && a[8] === null && typeof a[10] === 'string') && anchors.every((a, i) => i === 0 || a[1] - anchors[i - 1][1] >= AGGRO_ANCHOR_S - 1e-9 || a[10] !== anchors[i - 1][10]), `it owes the room an aggro anchor every AGGRO_ANCHOR_S ${AGGRO_ANCHOR_S} s and on each phase, carrying the phase`, `${anchors.length} anchors`)
  // She runs off at half again its charge: it pursues, losing ground, and past GIVE_UP_M gives her up and flies home.
  let gained = 0
  until(() => { her.x += 1.5 * CHARGE_MPS * DT; gained = Math.max(gained, dr.speed); return dr.live === null }, 60)
  check(gained > 0.9 * CHARGE_MPS && dr.state === 'rejoin' && dr.clip === 'fly' && Math.hypot(her.x - dr.x, her.z - dr.z) > GIVE_UP_M && Math.hypot(her.x - dr.x, her.z - dr.z) < GIVE_UP_M + 1, `she outruns it; once she is GIVE_UP_M ${GIVE_UP_M} m off it gives up and flies home on its rejoin`, `state ${dr.state}, ${fmt(Math.hypot(her.x - dr.x, her.z - dr.z))} m`)
  const rj = d.pending().filter((a) => a[7] === 'rejoin')
  check(rj.length === 1, 'owing the room its rejoin anchor', `${rj.length} rejoins`)
  Object.assign(her, { x: dr.x + 5, z: dr.z, open: true })
  d.quarry = quarry
  const spurnedFor = dr.spurned - now
  check(Math.abs(spurnedFor - SPURN_S) < TICK_S && d._spot(dr, now) === null && d._eye(dr, now) === null, `and for SPURN_S ${SPURN_S} s it spots nobody, her 5 m off in the open notwithstanding`, `spurned ${fmt(spurnedFor)} s`)
  d.dispose()
}

// --- aggro on her body: dead, she is fed on, chomp after chomp, a strider by notwithstanding; revived far off, it gives up ----
{
  const flat = flatField(GROUND)
  const site = homeSite(79)
  const d = dragonsOn(flat, [site], makeHerd([]), 5)
  d.plan = restPlan(d)
  let now = chapterOf(1000, keyOf(site)).start
  const spot = d._born(site, false).site
  const her = { x: spot.x + SPOT_M - 1, y: GROUND, z: spot.z, open: true, dead: false }
  const striders = []
  const quarry = { her, striders }
  const frame = () => { now += DT; d.update(her.x, her.y + 1.6, her.z, now, [], quarry) }
  const until = (ok, s) => { for (let i = 0; i < s * 60 && !ok(); i++) frame(); return ok() }
  d.update(her.x, her.y + 1.6, her.z, now)
  const dr = d.byKey.get(keyOf(site))
  until(() => dr.live !== null && dr.live.phase === 'chomp', 10)
  her.dead = true
  striders.push({ key: 'ws:1', x: dr.x - 10, y: GROUND, z: dr.z })
  const growls = dr.growlCue
  let left = false
  for (let i = 0; i < 4 * CHOMP_S * 60; i++) { frame(); if (dr.live === null || dr.live.phase !== 'chomp' || dr.clip !== 'eat') left = true }
  check(!left && dr.live.prey === HER_ID && dr.growlCue === growls && d.frights.length === 0 && d.hurt.length === 0, `dead, she is fed on: ${4 * CHOMP_S} s of the eat clip without a growl, a bite owed to harm, or a look at the strider 10 m off`, `phase ${dr.live?.phase}, clip ${dr.clip}, ${d.hurt.length} bites, ${d.frights.length} frights`)
  check(d._spot(dr, now) === null && d._eye(dr, now) !== HER_ID, 'and her body, close by and in the open, starts no chase of its own')
  her.dead = false
  her.x += 2 * GIVE_UP_M
  until(() => dr.live === null, 1)
  check(dr.state === 'rejoin', `revived ${2 * GIVE_UP_M} m off, it gives her up`, dr.state)
  d.dispose()
}

// --- aggro in the air: eyed in the open, it roars, swoops a circle, lands with a thud and charges ----
{
  const flat = flatField(GROUND)
  const site = homeSite(80)
  const d = dragonsOn(flat, [site], makeHerd([]), 5)
  // A rest, then a leg cruising 50 m up out east past where she stands, far enough to fly the whole check.
  d.plan = (key) => {
    const dr = d.byKey.get(key)
    const to = { x: 3000, y: GROUND + 50, z: 0, heading: 0, speed: PATROL_MPS * LOITER_PACE }
    const leg = d._legPhrase(dr.home, to, PATROL_MPS, 'patrol')
    return [{ kind: 'rest', dur: 1, from: dr.home, to: dr.home, at: dr.site, meal: false }, leg, { kind: 'rest', dur: 300, from: to, to: dr.home, at: dr.site, meal: false }]
  }
  let now = chapterOf(1000, keyOf(site)).start
  const her = { x: 400, y: GROUND, z: 20, open: false, dead: false }
  const striders = []
  const quarry = { her, striders }
  const frame = () => { now += DT; d.update(her.x, her.y + 1.6, her.z, now, [], quarry) }
  const until = (ok, s) => { for (let i = 0; i < s * 60 && !ok(); i++) frame(); return ok() }
  d.update(her.x, her.y + 1.6, her.z, now)
  const dr = d.byKey.get(keyOf(site))
  let rolls = 0
  d.random = () => { rolls++; return 0 }
  until(() => dr.x > her.x + EYE_M, 120)
  check(dr.live === null && rolls === 0, `flying over her under the trees, it never so much as rolls to eye her`, `${rolls} rolls`)
  // Around again, in the open, the dice against her: one roll the whole pass.
  her.open = true
  her.x = dr.x + 200
  d.random = () => { rolls++; return EYE_P + 0.01 }
  until(() => dr.x > her.x + EYE_M, 60)
  check(dr.live === null && rolls === 1, `in the open, it rolls once as she comes within EYE_M ${EYE_M} m, and at ${EYE_P + 0.01} passes her by`, `${rolls} rolls`)
  her.x = dr.x + 200
  d.random = () => EYE_P - 0.01
  until(() => dr.live !== null, 60)
  const roars = dr.roarCue
  check(dr.state === 'aggro' && dr.live.phase === 'swoop' && dr.clip === 'fly' && Math.hypot(her.x - dr.x, her.z - dr.z) <= EYE_M && dr.live.cx === her.x && roars === 1, `at ${EYE_P - 0.01} it eyes her within ${EYE_M} m, roars and swoops`, `phase ${dr.live?.phase}, roars ${roars}`)
  let lowest = Infinity, widest = 0, circled = 0
  // Its last half turn, once it has flown in onto the circle from wherever it eyed her.
  until(() => { if (dr.live.phase === 'swoop') { lowest = Math.min(lowest, dr.y); if (dr.live.swept > Math.PI) widest = Math.max(widest, Math.abs(Math.hypot(dr.x - dr.live.cx, dr.z - dr.live.cz) - CIRCLE_M)); circled = dr.live.swept }; return dr.live.phase !== 'swoop' }, 40)
  check(dr.live.phase === 'land' && circled >= 2 * Math.PI - 0.05 && widest < 8 && lowest > GROUND + 5, `it circles where it saw her once round, about CIRCLE_M ${CIRCLE_M} m out, before it comes down`, `swept ${fmt(circled)} rad, off the circle by ${fmt(widest)} m at worst, lowest ${fmt(lowest - GROUND)} m up`)
  const thuds = dr.thudCue
  until(() => dr.live.phase !== 'land', 25)
  check(dr.live.phase === 'spot' && dr.thudCue === thuds + 1 && dr.roarCue === roars && dr.clip === 'alert' && dr.y - GROUND < 4 && Math.abs(Math.hypot(her.x - dr.x, her.z - dr.z) - LAND_SHORT) < 6, `it lands about LAND_SHORT ${LAND_SHORT} m short of her with a thud, no second roar, and stands to find her`, `${fmt(Math.hypot(her.x - dr.x, her.z - dr.z))} m off, ${fmt(dr.y - GROUND)} m up`)
  until(() => dr.live.phase !== 'spot', SPOT_S + 0.1)
  check(dr.live.phase === 'charge', 'then charges her', dr.live.phase)
  // A strider in sight of the chase: it turns on the strider, which bolts, and charges after it.
  striders.push({ key: 'ws:1', x: dr.x - 10, y: GROUND, z: dr.z })
  until(() => dr.live.prey !== HER_ID, 1)
  check(dr.live.prey === 'ws:1' && dr.live.phase === 'spot' && dr.roarCue === roars + 1 && d.frights.length === 1 && d.frights[0][0] === 'ws:1', `a strider within SPOT_M ${SPOT_M} m of the chase: it loses interest in her, roars at the strider and sends it bolting`, JSON.stringify(d.frights))
  until(() => dr.live.phase !== 'spot', SPOT_S + 0.1)
  check(dr.live.phase === 'charge' && d.frights.length === 2, 'and charges after it, the strider bolting again from the charge', `${d.frights.length} frights`)
  striders.length = 0
  frame(); frame(); frame()
  check(dr.live === null && dr.state === 'rejoin', 'the strider gone from its sight, it gives up', dr.state)
  // A strider flown over at STRIDER_P's odds: swooped on just the same.
  her.x = -5000
  striders.push({ key: 'ws:2', x: 0, y: GROUND, z: 0 })
  dr.spurned = now
  const D2 = dragonsOn(flat, [site], makeHerd([]), 5)
  D2.plan = d.plan
  D2.random = () => 0
  let t2 = chapterOf(1000, keyOf(site)).start
  D2.update(0, GROUND, 0, t2)
  const d2 = D2.byKey.get(keyOf(site))
  striders[0].x = 400
  for (let i = 0; i < 60 * 60 && d2.live === null; i++) { t2 += DT; D2.update(0, GROUND, 0, t2, [], { her: null, striders }) }
  check(d2.live && d2.live.prey === 'ws:2' && d2.live.phase === 'swoop', 'a flying dragon eyes a strider within EYE_M and swoops on it', d2.live?.prey)
  D2.dispose()
  d.dispose()
}

// --- aggro across the room: the quarry's client steers, a peer trails its anchors ----
{
  const flat = flatField(GROUND)
  const site = homeSite(79)
  const born = () => { const dd = dragonsOn(flat, [site], makeHerd([]), 5); dd.plan = restPlan(dd); return dd }
  const A = born(), B = born()
  let now = chapterOf(1000, keyOf(site)).start
  const spot = A._born(site, false).site
  const her = { x: spot.x + SPOT_M - 1, y: GROUND, z: spot.z, open: false, dead: false }
  A.update(her.x, her.y, her.z, now)
  B.update(her.x, her.y, her.z, now)
  const a = A.byKey.get(keyOf(site)), b = B.byKey.get(keyOf(site))
  let worst = 0, sent = 0
  for (let i = 0; i < 6 * 60; i++) {
    now += DT
    her.x += 0.5 * CHARGE_MPS * DT
    A.update(her.x, her.y, her.z, now, [], { her, striders: [] })
    B.update(her.x, her.y, her.z, now)
    for (const an of A.pending()) { const s = an.slice(); s[8] = 'peerA'; B.apply(s, now); sent++ }
    if (i > 60) worst = Math.max(worst, Math.hypot(a.x - b.x, a.z - b.z))
  }
  check(b.state === 'aggro' && b.live.by === 'peerA' && b.live.phase === a.live.phase && b.clip === a.clip && B.pending().length === 0 && b.roarCue === 1, 'a peer\'s client puts its dragon on the chase from the anchors, in the same phase and clip, roaring once, owing nothing', `B ${b.state} ${b.live?.phase}, A ${a.live?.phase}`)
  check(worst < 1.5, 'and trails the steering client\'s dragon within a metre and a half', `${fmt(worst)} m at worst, ${sent} anchors`)
  const mine = born()
  mine.update(her.x, her.y, her.z, now - 0.5)
  const m = mine.byKey.get(keyOf(site))
  for (let t = now - 0.5 + DT; t <= now; t += DT) mine.update(her.x, her.y, her.z, t, [], { her: { ...her, x: m.x + 5 }, striders: [] })
  const theirs = A._anchor(a, now, 'aggro'); theirs[8] = 'peerA'
  mine.apply(theirs, now)
  check(m.live && m.live.by === null, 'a client steering its own chase of the dragon keeps it, a peer\'s aggro anchor notwithstanding')
  // The steering client gives up: the rejoin anchor puts the peer's dragon on the same rejoin.
  her.x = a.x + GIVE_UP_M + 1
  for (let i = 0; i < 10 && a.live !== null; i++) { now += DT; A.update(her.x, her.y, her.z, now, [], { her, striders: [] }) }
  const rj = A.pending().filter((an) => an[7] === 'rejoin')[0].slice(); rj[8] = 'peerA'
  B.apply(rj, now)
  check(a.state === 'rejoin' && b.state === 'rejoin' && b.live === null && b.rejoin.start === a.rejoin.start, 'and its rejoin anchor puts the peer\'s dragon on the same rejoin home')
  A.dispose(); B.dispose(); mine.dispose()
}

// --- a relief edit under a flying dragon --------------------------------------------------
{
  const flat = flatField(GROUND)
  const site = homeSite(77)
  const stags = [stag(150, 0)]
  const d = dragonsOn(flat, [site], makeHerd(stags), 11)
  const twin = dragonsOn(flat, [site], makeHerd([stag(150, 0)]), 11)
  const t0 = chapterOf(1000, keyOf(site)).start
  let now = t0
  const both = () => { now += DT; d.update(HER.x, HER.y, HER.z, now); twin.update(HER.x, HER.y, HER.z, now) }
  both()
  let dr = d.byKey.get(keyOf(site))
  let frames = 0
  while (dr.phrase.kind !== 'fly' && frames++ < 60 * 120) both()
  dr.cargo = stags[0]
  both()
  check(dr.phrase.kind === 'fly' && stags[0].carried === 1, 'a dragon in the air with a kill in its talons')
  d.place()
  check(stags[0].drops.join() === 'false' && d.byKey.size === 0 && d.free.length === MAX && d.freePuppets.length === PUPPETS && d.fading.length === 0 && d.cardMesh.count === 0, 'a relief edit puts every dragon away at once: the kill dropped with NO fade, every slot and puppet free, nothing dissolving')
  both()
  dr = d.byKey.get(keyOf(site))
  check(d.byKey.size === 1 && dr.phrase.kind === 'fly', 'and the next frame the roost has its dragon again, in the air on the same leg')
  for (let i = 0; i < 100 && d.stats.behind; i++) d.update(HER.x, HER.y, HER.z, now)
  const tw = twin.byKey.get(keyOf(site))
  check(!d.stats.behind && dr.rec.tick === tw.rec.tick && samePose(pose(dr), pose(tw)), 'caught up, it is where a client that never rebuilt has it, to the bit')
  d.dispose(); twin.dispose()
}

// --- the tail's lag: a turn bends the tail behind it, a reversal runs down it root first, and restore gives the clip back ---
{
  const root = new THREE.Bone(), a = new THREE.Bone(), b = new THREE.Bone(), c = new THREE.Bone()
  root.name = 'Root'; a.name = 'Tail'; b.name = 'Tail1'; c.name = 'Tip'
  a.position.set(-1, 0, 0); b.position.set(-1, 0, 0); c.position.set(-1, 0, 0)
  root.add(a); a.add(b); b.add(c)
  const bones = [root, a, b, c]
  const lag = new TailLag(bones, ['Tail', 'Tail1'])
  const tipZ = () => { root.updateMatrixWorld(true); return c.getWorldPosition(new THREE.Vector3()).z }
  const localBend = (bone) => new THREE.Euler().setFromQuaternion(bone.quaternion, 'YZX').y
  let heading = 0
  const turn = (rate, s) => { for (let i = 0; i < s * 60; i++) { lag.restore(); heading += rate / 60; lag.steer(heading, 0); lag.solve(1 / 60) } }
  turn(0, 0.5)
  check(Math.abs(tipZ()) < 1e-9, 'flying straight, the tail lies straight behind')
  turn(0.6, 2)
  // Turning +Y swings the nose toward -Z, the side the arc's centre is on, and a tail following the arc curls that way too.
  const held = tipZ()
  check(held < -0.1 && localBend(a) < 0 && localBend(b) < 0, 'a steady turn bends every joint behind the swing, so the tail curls along the arc, into the turn', `tip z ${fmt(held)}, bends ${fmt(localBend(a))} ${fmt(localBend(b))}`)
  turn(-0.6, 0.15)
  check(localBend(a) > 0 && localBend(b) < 0, 'a reversal reaches the root before the tip: the tail makes an S', `bends ${fmt(localBend(a))} ${fmt(localBend(b))}`)
  lag.restore()
  check(a.quaternion.equals(new THREE.Quaternion()) && b.quaternion.equals(new THREE.Quaternion()), 'restore puts back the pose it bent, so the mixer never compounds it')
  turn(3, 1)
  check(Math.abs(localBend(a)) <= BEND_MAX + 1e-9 && Math.abs(localBend(b)) <= BEND_MAX + 1e-9, `however hard the turn, no joint bends past ${BEND_MAX} rad`, `bends ${fmt(localBend(a))} ${fmt(localBend(b))}`)
  lag.reset()
  lag.steer(heading, 0); lag.solve(1 / 60)
  check(Math.abs(localBend(a)) < 1e-9 && Math.abs(tipZ()) < 1e-9, 'reset forgets the turn: a puppet handed to another dragon starts straight')
}

// --- the rungs: puppet near, two fixed cards far, nothing past that, simulated throughout, drawn between ticks --
{
  const flat = flatField(GROUND)
  const site = homeSite(9)
  const d = dragonsOn(flat, [site], makeHerd([]), 5)
  const t0 = chapterOf(1000, keyOf(site)).start
  let now = t0
  d.update(HER.x, HER.y, HER.z, now)
  const dr = d.byKey.get(keyOf(site))
  const reach = (k) => lodReach(dr.lodSize, k)
  const at = (dist, frames = 90) => { for (let i = 0; i < frames; i++) { now += DT; d.update(site.x + dist, HER.y, site.z, now) } return dr.lod }
  check(at(reach(0) * 0.9) === 0 && dr.puppet && dr.puppet.tier === 0, `inside ${reach(0).toFixed(0)} m it is a puppet on the top tier`)
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
  // Drawn between its last two ticks: the puppet stands at the blend of them by the frame's alpha.
  {
    let checked = 0, off = 0
    for (let i = 0; i < 60; i++) {
      now += DT
      d.update(site.x + reach(0) * 0.9, HER.y, site.z, now)
      const al = dr.rec.alpha
      if (al <= 0.05 || al >= 0.95) continue
      dr.puppet.group.matrix.decompose(p, q, s)
      checked++
      const want = { x: dr.px + (dr.x - dr.px) * al, y: dr.py + (dr.y - dr.py) * al, z: dr.pz + (dr.z - dr.pz) * al }
      if (Math.abs(p.x - want.x) > 1e-9 || Math.abs(p.y - want.y) > 1e-9 || Math.abs(p.z - want.z) > 1e-9 || Math.abs(s.x - dr.k) > 1e-9) off++
    }
    check(checked > 20 && off === 0 && d.batch.children.includes(dr.puppet.group), 'the puppet\'s matrix is the dragon\'s between its last two ticks, blended by the frame\'s alpha, at its size, and in the batch', `${checked} frames between ticks`)
  }
  check(at(reach(LOD_RUNGS - 1) * 0.9) === LOD_RUNGS - 1 && dr.puppet && dr.puppet.tier === LOD_RUNGS - 1, `at ${(reach(LOD_RUNGS - 1) * 0.9).toFixed(0)} m it is on the bottom mesh tier, still a puppet`)
  // A kill in its talons for the rest of the walk out, to see what it is told about the dragon's own rung.
  const kill = stag(0, 0)
  dr.cargo = kill
  check(at(reach(LOD_RUNGS) * 0.9) === LOD_RUNGS && !dr.puppet && d.cardN === 1 && d.cardMesh.count === 1 && d.freePuppets.length === PUPPETS, `at ${(reach(LOD_RUNGS) * 0.9).toFixed(0)} m the puppet is given back and the two cards drawn instead`)
  check(kill.carried > 0 && kill.shown === true, 'and the kill it carries is told the dragon is drawn, so its card holds under the dragon\'s')
  d.cardMesh.getMatrixAt(0, m)
  m.decompose(p, q, s)
  const e = new THREE.Euler().setFromQuaternion(q, 'YZX')
  const al = dr.rec.alpha
  const blend = (a, b) => a + (b - a) * al
  check(Math.abs(p.x - blend(dr.px, dr.x)) < 1e-6 && Math.abs(p.y - blend(dr.py, dr.y)) < 1e-6 && Math.abs(p.z - blend(dr.pz, dr.z)) < 1e-6 && Math.abs(s.x - dr.k) < 1e-6, 'the card instance stands where the dragon is between its ticks, at its size')
  check(Math.abs(swing(e.y, dr.pheading + swing(dr.pheading, dr.heading) * al)) < 1e-6 && Math.abs(e.z - blend(dr.ppitch, dr.pitch)) < 1e-6 && Math.abs(e.x - blend(dr.proll, dr.roll)) < 1e-6, 'and carries its whole orientation -- heading, pitch AND roll -- since a fixed pair of quads is turned by its matrix and by nothing else', `yaw ${fmt(e.y)} pitch ${fmt(e.z)} roll ${fmt(e.x)}`)
  check(d.cardFade.array[0] === 1, 'settled: the whole card is drawn, no dither left', `fade ${d.cardFade.array[0]}`)
  check(at(reach(LOD_RUNGS) * 4) === CARD_RUNGS && d.cardN === 0 && d.cardMesh.count === 0 && !dr.puppet && d.byKey.size === 1, `four times the card's reach, it is drawn as nothing at all -- and is still alive`)
  check(kill.shown === false, 'and the kill is told so, and goes with it')
  dr.cargo = null
  const before = { x: dr.x, z: dr.z, state: dr.state, tick: dr.rec.tick }
  for (let i = 0; i < 60 * 120; i++) { now += DT; d.update(site.x + reach(LOD_RUNGS) * 4, HER.y, site.z, now) }
  check(dr.rec.tick === tickOf(now) && dr.rec.tick - before.tick === 120 * 20 && (dr.state !== before.state || dr.x !== before.x || dr.z !== before.z), 'and still simulated out of sight: two minutes on, every tick of it is run and it has been about its score', `now ${dr.state} at (${fmt(dr.x)}, ${fmt(dr.z)})`)
  check(d.stats.alive === 1 && d.stats.lod.length === LOD_RUNGS && d.stats.cards === 0 && typeof d.stats.states === 'object' && d.stats.starved === 0 && d.stats.overflow === 0 && d.stats.live === 0 && d.stats.behind === 0, 'the stats read alive, a row a mesh rung, the cards, the states and the counters', JSON.stringify(d.stats))
  d.dispose()
}

// --- the pair: the guard keeps its half of the nest every chapter while the male flies, the two abreast on one heading, each its own colour ----
{
  const flat = flatField(GROUND)
  const site = homeSite(4321)
  const d = dragonsOn(flat, [site], makeHerd([]), 3, dry, Dragons)
  const t0 = chapterOf(1000, keyOf(site)).start
  d.update(HER.x, HER.y, HER.z, t0)
  const g = d.byKey.get(keyOf(site, true)), m = d.byKey.get(keyOf(site))
  check(d.byKey.size === 2 && g.guard && !m.guard && d.free.length === MAX - 2, 'a roost is born a pair: the guard, keyed :g, and the male')
  const [gu, gv, mu, mv] = [g.site.x - site.x, g.site.z - site.z, m.site.x - site.x, m.site.z - site.z]
  const H = g.home.heading
  check(Math.abs(gu + mu) < 1e-9 && Math.abs(gv + mv) < 1e-9 && Math.abs(Math.hypot(gu, gv) - 0.75 * site.r) < 1e-9 && m.home.heading === H && Math.abs(gu * Math.cos(H) - gv * Math.sin(H)) < 1e-9, 'they stand abreast either side of the floor\'s centre, facing the same way')
  const gch = Array.from({ length: 6 }, (_, c) => d.score.chapter(keyOf(site, true), t0 + c * CHAPTER_S))
  check(gch.every((c) => c.phrases.every((p) => p.kind === 'rest' && p.at === g.site) && Math.abs(c.phrases.reduce((sum, p) => sum + p.dur, 0) - CHAPTER_S) < 1e-6) && gch.every((c) => c.phrases.slice(0, -1).every((p) => p.dur <= REST_S[1])), 'the guard\'s every chapter is rests on its own spot, none but the last longer than REST_S, summing to the chapter')
  const states = { g: new Set(), m: new Set() }
  let gFar = 0
  for (let i = 1; i <= 60 * CHAPTER_S; i++) {
    d.update(HER.x, HER.y, HER.z, t0 + i / 60)
    states.g.add(g.state); states.m.add(m.state)
    gFar = Math.max(gFar, Math.hypot(g.x - g.site.x, g.z - g.site.z))
    if (d.stats.behind) throw new Error(`the pair fell behind the clock at frame ${i}`)
  }
  check(states.g.size === 1 && states.g.has('roost') && gFar <= WALK_RING * site.r + WAY * g.k, 'flown through a chapter the guard never leaves the nest, pottering about its own spot', `${[...states.g].join(' ')}, ${fmt(gFar)} m out at most`)
  check(states.m.has('patrol') || states.m.has('explore'), 'while the male flies out', [...states.m].join(' '))
  d.dispose()

  // Colour: the roost's key rolls it, so every client paints the same pair, and the guard is the vivid one.
  const chroma = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)
  const sites = Array.from({ length: 12 }, (_, k) => ({ ...homeSite(500 + k), x: k * 40 }))
  const many = dragonsOn(flat, sites, makeHerd([]), 3, dry, Dragons), twin = dragonsOn(flat, sites, makeHerd([]), 3, dry, Dragons)
  many.update(HER.x, HER.y, HER.z, t0); twin.update(HER.x, HER.y, HER.z, t0 + 77)
  const all = [...many.byKey.values()]
  check(all.length === 24 && all.every((dr) => dr.tint.equals(twin.byKey.get(dr.key).tint)), 'every dragon\'s tint is a function of its key: another instance paints the same 24')
  const lead = new Set(all.map((dr) => ['r', 'g', 'b'].reduce((a, c) => (dr.tint[c] > dr.tint[a] ? c : a))))
  check(lead.size === 3, 'across a dozen roosts the hues run red, green and blue', [...lead].join(''))
  const mean = (guard) => all.filter((dr) => dr.guard === guard).reduce((sum, dr) => sum + chroma(dr.tint), 0) / 12
  check(mean(true) > mean(false) * 1.2, `the guards, pushed ${GUARD_VIVID} from grey where the males are held to ${MALE_VIVID}, are the more vivid`, `${fmt(mean(true))} over ${fmt(mean(false))}`)
  many.dispose(); twin.dispose()
}

// --- a roost that goes, too many roosts, and too many in mesh range: every roost a pair -------------------
{
  const flat = flatField(GROUND)
  const sites = [{ key: 1, tx: 1, tz: 0, x: 0, y: GROUND, z: 0, r: 4, gx: 0, gz: 0 }]
  const roosts = roostOf(sites)
  const d = new Dragons(new THREE.Scene(), flat, { seed: 2, roosts, wildlife: makeHerd([]), water: dry, harm: () => {}, fright: () => {}, asset: makeAsset() })
  let now = chapterOf(1000, keyOf(sites[0])).start
  const step = () => { now += DT; d.update(HER.x, HER.y, HER.z, now) }
  step()
  const dr = d.byKey.get(keyOf(sites[0])), gd = d.byKey.get(keyOf(sites[0], true))
  check(d.byKey.size === 2 && dr.puppet && gd.puppet, 'a roost is a pair, and with her beside the nest both wear puppets')
  sites.length = 0
  step()
  check(d.byKey.size === 0 && d.free.length === MAX && dr.site === null && gd.site === null && d.fading.length === 2 && d.freePuppets.length === PUPPETS - 2, 'the frame its roost goes the pair are retired and their bodies left to dissolve')
  for (let i = 0; i < 60 * 3; i++) step()
  check(d.fading.length === 0 && d.freePuppets.length === PUPPETS, 'and the puppet is back in the pool once the dissolve is done')

  for (let k = 0; k < MAX / 2 + 1; k++) sites.push({ key: 100 + k, tx: 100 + k, tz: 0, x: k * 8, y: GROUND, z: 0, r: 4, gx: 0, gz: 0 })
  step()
  check(d.byKey.size === MAX && d.stats.overflow === 2 && d.free.length === 0, `${MAX / 2 + 1} roosts in range is one more pair than there are slots: ${MAX} fly and the overflow is counted`)
  check(d.stats.puppets === PUPPETS && d.stats.starved > 0 && Array.from(d.byKey.values()).filter((x) => x.puppet).length === PUPPETS, `all of them at her feet, ${PUPPETS} wear puppets and the rest are counted starved rather than drawn wrong`, `starved ${d.stats.starved}`)
  sites.length = 0
  step()
  check(d.byKey.size === 0 && d.free.length === MAX && d.fading.length === PUPPETS, 'every roost gone, every dragon retired, the puppets they wore dissolving')
  d.dispose()
  check(d.batch.parent === null && d.freePuppets.length === PUPPETS, 'disposed, the batch is out of the scene and every puppet parked')
}

console.log(`\n${failures} failing`)
process.exit(failures ? 1 : 0)
