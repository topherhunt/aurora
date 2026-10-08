// Node-side gates for the frogs (src/v2/render/frogs.js).
//
//   node scripts/check-frogs.mjs
//
// The scatter runs against a synthetic world: flat ground at y = 10 with a
// straight river along z at x = 0 (banks at |x| = 4), the snow line dropping to
// the ground for z > 60 (cold), and one boulder at (8, 0). Everything below is
// a way a frog can go wrong without anything throwing: a frog in the water, in
// the cold, on the boulder or past the shore band; a shore with the wrong
// number of frogs for the density; frogs all one size or one colour; a segment
// that is not a sit, a bout and a sit, or not eight seconds, or not from its
// grid turn, or between posts that are wet, off the band, on the boulder or
// off the tether, or that does not take up where the last ended; a frog not at
// its post at the turn; a frog that never hops, that hops off the band, that
// lands on the boulder or rests past its tether; a walk whose hops are
// leap-sized or wander off its line, a bout with the wrong beat between its
// hops; a frog that never lands in the river, or that sits on the bed or on
// top of the surface there instead of half under it, or tilted, or does not
// bob there, or rests there for the wrong while, or never comes out and hops
// on; two clients on different frames, or one joining mid-segment, with a
// frog in two places; a frog that ignores a spider in her hand, or chases a
// carrot, or a peer's spider its set does not name, or that never rejoins its
// plan after, or rejoins it anywhere but the next post; a lured set the room
// is not told of, or told of twice, or not told is emptied; a scatter that is
// not the same twice, or that seats a frog in the water; a frog standing level
// on a slope, or still tilted to the slope it left after a hop; a frame that
// costs more than a scatter is allowed to; a frog drawn as a tier its apparent
// size does not call for, or drawn at all under the last rung, a tier that
// flickers as her head sways on a threshold, or a tier instance that is not
// its frog's own matrix, tint and hue.
// The shipped GLB and its ladder are checked for existence, shape and facing
// too, because the world loads them by name and hops them along +X.
//
// What this can NOT check: whether they look like frogs, or how the hop reads.
// That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import { Frogs, DENSITY, TILE, SHORE_M, SIZE_M, MAX, TETHER_M, BREATH_S, BREATH_AMP, SINK, BOB_S, BOB_AMP, SIT_S, WALK, LEAP, HOPS_MAX, WET_PAUSE_S, WADE_M, WET_ROUGHNESS, MORPHS, LOD_TIERS, LURES, LURE_M, LURE_FORGET_M, CHASE, ORBIT_M, NOTICE_S, REJOIN_MIN_S, bedKey, keyOf } from '../src/v2/render/frogs.js'
import { GRID_S, keyHash } from '../src/sim/score.js'
import { CRITTER_GLB, GLINT, LOD_HYSTERESIS, TIER_TINTS, critterLodUrl, critterTier, cullRange, lodReach, setTierTint } from '../src/v2/render/critters.js'
import { TEX_PX_MAX, TEX_PX_SMALL } from '../tools/creatures/creature-roster.mjs'
import { webpSize } from '../tools/tripo-pack.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- the synthetic world -----------------------------------------------------
const GROUND = 10
const HALF = 4
const LEVEL = GROUND + 0.5
const COLD_Z = 60
const ROCK = { x: 8, z: 0, r: 1.5, top: 11 }
const inRock = (x, z) => Math.hypot(x - ROCK.x, z - ROCK.z) < ROCK.r
const height = {
  heightAt: () => GROUND,
  heightAndSlopeAt: () => ({ h: GROUND, tan: 0, gx: 0, gz: 0 }),
  // Warm everywhere but the far end, where the snow reaches the ground.
  snowLineAt: (x, z) => (z > COLD_Z ? GROUND : GROUND + 500),
}
const water = {
  levelAt: (x) => (Math.abs(x) < HALF ? LEVEL : null),
  shoreDistAt(x, z, reach) {
    if (!(reach > 0)) throw new Error('reach')
    const d = Math.abs(x) - HALF
    return d > reach ? reach : d < -reach ? -reach : d
  },
}
const rocks = { blockTopAt: (x, z) => (inRock(x, z) ? ROCK.top : -Infinity) }
// A drawn surface a hand above the field, to see the frogs seat on it rather than the field; `lift` moves it, as a chunk re-splitting does, and the version ticks as the terrain's does.
const ground = { lift: 0.05, groundVersion: 0, groundAt() { return GROUND + this.lift } }

// --- the shipped asset -------------------------------------------------------
{
  const file = new URL(`../public/${CRITTER_GLB.frog}`, import.meta.url)
  check(fs.existsSync(file), `${CRITTER_GLB.frog} is shipped -- run tools/creatures/ship.mjs`)
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file)
    check(buf.toString('latin1', 0, 4) === 'glTF', 'the frog GLB has a glTF header')
    const jsonLen = buf.readUInt32LE(12)
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen))
    check(json.meshes?.length === 1 && json.meshes[0].primitives.length === 1, 'one mesh, one primitive', `${json.meshes?.length} meshes`)
    check(json.images?.length >= 1 && json.materials?.[0]?.pbrMetallicRoughness?.baseColorTexture !== undefined, 'a base colour texture to draw')
    // Packed (tools/creatures/ship.mjs): the colour map is a WebP beside the GLB at the roster's small size, and Tripo's own JPEGs -- colour, ORM, normal -- are gone.
    const image = json.images?.[0]
    check(image?.uri?.endsWith('.webp') && image.bufferView === undefined && json.images.length === 1, 'the one image is the packed WebP beside the GLB, not an embedded JPEG', JSON.stringify(json.images))
    check(image?.uri && fs.existsSync(new URL(image.uri, file)), 'and it is shipped')
    if (image?.uri && fs.existsSync(new URL(image.uri, file))) {
      const { width, height } = webpSize(fs.readFileSync(new URL(image.uri, file)))
      check(width === TEX_PX_SMALL && height === TEX_PX_SMALL && width <= TEX_PX_MAX, `the colour map is ${TEX_PX_SMALL}px square`, `${width}x${height}`)
    }
    check(json.extensionsRequired?.includes('EXT_texture_webp') && json.textures?.[0]?.extensions?.EXT_texture_webp?.source === 0, 'the texture declares EXT_texture_webp')
    const pbr = json.materials?.[0]?.pbrMetallicRoughness
    check(pbr?.metallicFactor === 0 && pbr.metallicRoughnessTexture === undefined && json.materials[0].normalTexture === undefined, 'no metalness, and the ORM and normal maps are gone', JSON.stringify(json.materials?.[0]))
    // Facing: the eyes are the top of a crouched frog, so the highest vertices' centroid lies ahead of the body's, and ahead must be +X once the node's matrix is applied -- ship.mjs turns the pick there by the roster's faceTurnDeg, measured per pick, and its ladder the same.
    const node = json.nodes.find((n) => n.mesh !== undefined)
    check(!node.rotation && !node.translation && !node.scale, 'the mesh node carries its transform as one matrix')
    const { ahead, tris } = shape(buf, json)
    check(Math.abs(ahead) < 10, 'the frog faces +X: its eyes lie ahead of its body along +X', `head ${ahead.toFixed(1)} deg from +X`)
    let last = tris
    for (let k = 1; k < LOD_TIERS; k++) {
      const url = critterLodUrl(CRITTER_GLB.frog, k)
      const tierFile = new URL(`../public/${url}`, import.meta.url)
      check(fs.existsSync(tierFile), `${url} is shipped`)
      if (!fs.existsSync(tierFile)) continue
      const tierBuf = fs.readFileSync(tierFile)
      const tierJson = JSON.parse(tierBuf.toString('utf8', 20, 20 + tierBuf.readUInt32LE(12)))
      const t = shape(tierBuf, tierJson)
      check(t.tris < last && tierJson.images?.[0]?.uri === image?.uri, `tier ${k} is coarser than the one above and wears the pick's WebP`, `${t.tris} tris after ${last}`)
      // The coarsest tier is lopsided today (the decimator's doing, see the design doc); the world still needs it looking the right way.
      check(Math.abs(t.ahead) < 25, `tier ${k} faces +X`, `head ${t.ahead.toFixed(1)} deg from +X`)
      last = t.tris
    }
  }
}

/** A GLB's triangle count and the bearing of its highest vertices from its centroid, degrees from +X, after the mesh node's matrix. */
function shape(buf, json) {
  const jsonLen = buf.readUInt32LE(12)
  const node = json.nodes.find((n) => n.mesh !== undefined)
  const m = node.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const prim = json.meshes[0].primitives[0]
  const acc = json.accessors[prim.attributes.POSITION]
  const view = json.bufferViews[acc.bufferView]
  const binOff = 20 + jsonLen + 8
  const pos = new Float32Array(buf.buffer.slice(buf.byteOffset + binOff + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0), buf.byteOffset + binOff + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0) + acc.count * 12))
  const pts = []
  for (let i = 0; i < acc.count; i++) {
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2]
    pts.push([m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]])
  }
  const yTop = Math.max(...pts.map((p) => p[1])), yFoot = Math.min(...pts.map((p) => p[1]))
  const mean = (list) => list.reduce((a, p) => [a[0] + p[0] / list.length, a[1] + p[1] / list.length, a[2] + p[2] / list.length], [0, 0, 0])
  const body = mean(pts)
  const head = mean(pts.filter((p) => p[1] > yFoot + 0.85 * (yTop - yFoot)))
  return { ahead: Math.atan2(-(head[2] - body[2]), head[0] - body[0]) * 180 / Math.PI, tris: json.accessors[prim.indices].count / 3 }
}

// --- stand-in assets: a unit box, feet at y = 0, and a coarser one for each tier --------------
const boxAsset = (segments) => {
  const box = new THREE.BoxGeometry(1, 0.5, 0.7, segments, segments, segments).translate(0, 0.25, 0)
  return { pos: box.getAttribute('position').array, nrm: box.getAttribute('normal').array, uv: box.getAttribute('uv').array, idx: Array.from(box.index.array), map: null }
}
const asset = Array.from({ length: LOD_TIERS }, (_, k) => boxAsset(LOD_TIERS - k))

// --- construction and the shader hook -----------------------------------------
const scene = new THREE.Scene()
const frogs = new Frogs(scene, height, water, { seed: 7, rocks, ground, assets: asset })
check(frogs.loaded && frogs.tiers.length === LOD_TIERS && frogs.tiers.every((t) => t.visible && t.parent === frogs.batch) && Math.abs(frogs.span - 1) < 1e-6, 'assets set: every tier visible in the batch, span 1', `span ${frogs.span}`)
// The stand-in is half as tall as it is long, so a floating frog's feet sit SINK of that under the surface, per metre of size.
check(Math.abs(frogs.sink - SINK * 0.5) < 1e-6 && SINK === 0.5, 'a floating frog sinks half its height', `sink ${frogs.sink} per metre of size`)
const afloatY = (f) => LEVEL - f.size * frogs.sink
check(frogs.tiers.every((t, k) => t.geometry.index.count === asset[k].idx.length && t.material === frogs.material), 'each tier wears its own geometry under the one material')
check(frogs.tiers.every((t) => t.instanceColor && t.instanceColor.isInstancedBufferAttribute), 'tint rides in instanceColor')
check(frogs.tiers.every((t, k) => t.geometry.getAttribute('aHue') === frogs.hues[k] && frogs.hues[k].isInstancedBufferAttribute) && frogs.mesh === frogs.tiers[0], 'hue rides in aHue on every tier')
{
  const shader = { vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <lights_fragment_end>\n' }
  frogs.material.onBeforeCompile(shader)
  // The hue turn: read per instance, carried across, and applied to the sampled map before it is lit.
  check(shader.vertexShader.includes('attribute float aHue;') && shader.vertexShader.includes('vHue = aHue;') && /<map_fragment>\s*\{[^}]*cross\( hueK, diffuseColor\.rgb \)/.test(shader.fragmentShader), 'the hue turns the sampled colour after map_fragment')
  // The glint: a Standard at the hand-set wet roughness, no metalness, three's own roughness sampler left alone, the lobe scaled by GLINT.
  check(frogs.material.isMeshStandardMaterial && frogs.material.roughness === WET_ROUGHNESS && WET_ROUGHNESS > 0 && WET_ROUGHNESS < 1 && frogs.material.metalness === 0, 'a Standard material at WET_ROUGHNESS with no metalness', `${frogs.material.type} roughness ${frogs.material.roughness}`)
  check(shader.fragmentShader.includes('<roughnessmap_fragment>') && !shader.fragmentShader.includes('sampledDiffuseColor.a'), 'the colour alpha is not read as roughness')
  check(shader.fragmentShader.includes(`reflectedLight.directSpecular *= ${GLINT.toFixed(2)};`) && GLINT > 0 && GLINT < 1, 'the glint is scaled down after lights_fragment_end', `GLINT ${GLINT}`)
}
// The tint row (critters.js TIER_TINTS): four tiers on one material cannot each wear a uniform, so each tier's mesh is swapped onto its own flat colour on the next update, and back.
{
  setTierTint(true)
  frogs.update(0, GROUND + 1.6, 0, 0)
  check(frogs.tiers.every((t, k) => t.material === TIER_TINTS[k]) && new Set(frogs.tiers.map((t) => t.material)).size === LOD_TIERS, 'on, each tier wears the flat colour of its rung, no two alike')
  setTierTint(false)
  frogs.update(0, GROUND + 1.6, 0, 1 / 60)
  check(frogs.tiers.every((t) => t.material === frogs.material), 'off, every tier is back on the one shared material')
}

// --- placement ---------------------------------------------------------------
const alive = () => frogs.slots.filter((f) => f.tile !== null)
frogs.place(0, 0)
{
  const all = alive()
  check(all.length > 20, 'the river bank fills with frogs', JSON.stringify(frogs.stats))
  check(all.every((f) => Math.abs(f.x) >= HALF), 'no frog in the river', `${all.filter((f) => Math.abs(f.x) < HALF).length} wet`)
  check(all.every((f) => Math.abs(f.x) < HALF + SHORE_M), `every frog within ${SHORE_M} m of the bank`, `furthest ${Math.max(...all.map((f) => Math.abs(f.x) - HALF)).toFixed(2)} m`)
  check(all.every((f) => !inRock(f.x, f.z)), 'no frog on the boulder')
  check(all.every((f) => Math.abs(f.y - (GROUND + 0.05)) < 1e-6), 'frogs seat on the drawn ground, not the field')
  // Expected count: a SHORE_M band on each bank, as long as the column of resident tiles along the river, at DENSITY.
  const rows = [...frogs.tiles.values()].filter((t) => t.tx === 0).length
  const expected = DENSITY * 2 * SHORE_M * rows * TILE
  check(all.length > expected * 0.6 && all.length < expected * 1.4, 'the count is about the density times the band', `${all.length} frogs, ~${expected.toFixed(0)} expected over ${rows * TILE} m of bank`)
  const sizes = all.map((f) => f.size)
  check(Math.min(...sizes) >= SIZE_M[0] && Math.max(...sizes) <= SIZE_M[1] && Math.max(...sizes) - Math.min(...sizes) > 0.03, 'sizes vary across the range', `${Math.min(...sizes).toFixed(3)}..${Math.max(...sizes).toFixed(3)} m`)
  const tints = new Set(all.map((f) => `${f.r.toFixed(2)},${f.g.toFixed(2)},${f.b.toFixed(2)}`))
  check(tints.size > all.length * 0.8, 'tints vary', `${tints.size} distinct of ${all.length}`)
  const hues = all.map((f) => f.hue)
  check(new Set(hues.map((h) => h.toFixed(3))).size > all.length * 0.8 && Math.min(...hues) < -0.5 && Math.max(...hues) > 0.2, 'hues vary, from a quarter turn toward orange to a shade toward blue', `${Math.min(...hues).toFixed(2)}..${Math.max(...hues).toFixed(2)} rad`)
  // Every frog wears one morph whole -- hue and all three tint channels inside the same entry -- and the bank holds every morph, the browns turned well toward orange and darkened warm.
  const within = (v, [lo, hi]) => v >= lo - 1e-9 && v <= hi + 1e-9
  const morphOf = (f) => MORPHS.find((m) => within(f.hue, m.hue) && within(f.r, m.r) && within(f.g, m.g) && within(f.b, m.b))
  const worn = new Map(MORPHS.map((m) => [m.name, 0]))
  for (const f of all) { const m = morphOf(f); if (m) worn.set(m.name, worn.get(m.name) + 1) }
  check(all.every((f) => morphOf(f)) && [...worn.values()].every((n) => n > 0), 'each frog wears one morph whole and every morph is on the bank', [...worn].map(([k, v]) => `${k} ${v}`).join(', '))
  const brown = MORPHS.find((m) => m.name === 'brown')
  const mid = ([lo, hi]) => (lo + hi) / 2
  check(brown && brown.hue[1] <= -0.75 && mid(brown.r) > mid(brown.g) && mid(brown.g) > mid(brown.b) && brown.r[1] < 1, 'the brown morph turns the green a quarter of the wheel and tints it dark and warm')
  check(frogs.overflow === 0, 'the pool was not saturated', `${MAX} slots`)
}
// Cold: standing on the boundary, the warm half has frogs and the cold half none.
frogs.place(0, COLD_Z)
{
  const all = alive()
  check(all.length > 0 && all.every((f) => f.z <= COLD_Z), 'no frog where the snow line is at the ground', `${all.length} frogs on the warm side, ${all.filter((f) => f.z > COLD_Z).length} on the cold`)
}
// Determinism: the same tile, the same frogs.
frogs.place(0, 0)
const snapA = alive().map((f) => [f.homeX, f.homeZ, f.size, f.r]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
frogs.place(50, 50)
frogs.place(0, 0)
const snapB = alive().map((f) => [f.homeX, f.homeZ, f.size, f.r]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
check(JSON.stringify(snapA) === JSON.stringify(snapB), 'placement is a pure function of position', `${snapA.length} frogs`)

// What is drawn: every tier's instances, each with its distance from `head` and the frog whose seat it stands on.
const at = (mesh, i) => { const e = mesh.instanceMatrix.array; return [e[i * 16 + 12], e[i * 16 + 13], e[i * 16 + 14]] }
const drawn = (head) => {
  const out = []
  frogs.tiers.forEach((mesh, tier) => {
    for (let i = 0; i < mesh.count; i++) {
      const p = at(mesh, i)
      const f = alive().find((g) => Math.abs(g.x - p[0]) < 1e-4 && Math.abs(g.z - p[2]) < 1e-4)
      out.push({ tier, i, p, f, dist: Math.hypot(p[0] - head[0], p[1] - head[1], p[2] - head[2]) })
    }
  })
  return out
}
const drawnCount = () => frogs.tiers.reduce((n, t) => n + t.count, 0)

// --- the run: a minute of the room's clock ------------------------------------
const DT = 1 / 72
const SECONDS = 60
// Some world time, nowhere near zero, so an offset or a segment index being dropped shows.
const T0 = 12345.6
const HEAD = [HALF + 1, GROUND + 1.6, 0]
const homes = new Map(alive().map((f) => [f, { x: f.homeX, z: f.homeZ }]))
const hopLen = (ph) => Math.hypot(ph.to.x - ph.from.x, ph.to.z - ph.from.z)
const onBand = (x) => Math.abs(x) < HALF + SHORE_M + 1e-9
let hopped = 0, offBand = 0, onRock = 0, strayed = 0, maxStray = 0
// The water: frames afloat, of them off the sunk level or tilted; the frogs that went in and that came back out to hop on land after.
let afloat = 0, afloatOff = 0, afloatTilted = 0
const wentIn = new Set(), cameOut = new Set(), hoppedAfter = new Set()
// Every segment planned, read once as its frog takes it up: its shape and its gait. A walk's landings are each swung off its line by up to sin(WALK.turn) of the reach, so two hops turn at most twice the angle of that swing doubled.
const segs = new Set()
const bouts = { walk: 0, leap: 0, none: 0 }
let badSeg = 0, badPost = 0, badLanding = 0, badReach = 0, badPause = 0, wetPauses = 0, badWetPause = 0, disjoint = 0, offPost = 0, walkPairs = 0, straight = 0, hurried = 0
const turn = (a) => Math.abs(Math.atan2(Math.sin(a), Math.cos(a)))
const readSeg = (f, now) => {
  const seg = f.seg
  if (segs.has(seg)) return
  segs.add(seg)
  const { phrases, a, b } = seg
  const total = phrases.reduce((sum, ph) => sum + ph.dur, 0)
  if (Math.abs(total - GRID_S) > 1e-9 || Math.abs(seg.start - (seg.g * GRID_S + f.offset)) > 1e-9 || phrases[0].kind !== 'sit' || phrases[0].at !== a || phrases[phrases.length - 1].kind !== 'sit' || (phrases.length > 1 && phrases[phrases.length - 1].at !== b)) badSeg++
  if (phrases[0].dur < SIT_S[0] - 1e-9 || (phrases.length > 1 && phrases[0].dur > SIT_S[1] + 1e-9)) badSeg++
  for (const post of [a, b]) if ((post.wet && Math.abs(post.x) < HALF - WADE_M) || !onBand(post.x) || inRock(post.x, post.z) || Math.hypot(post.x - f.homeX, post.z - f.homeZ) > TETHER_M + 1e-9) badPost++
  // The frog takes the segment up where the segment before left it, and is there.
  if (f.last && f.last.g === seg.g - 1 && f.last.b !== a) disjoint++
  if (Math.abs(now - seg.start) < DT && (Math.abs(f.x - a.x) > 1e-9 || Math.abs(f.z - a.z) > 1e-9)) offPost++
  f.last = seg
  const hops = phrases.filter((ph) => ph.kind === 'hop')
  if (hops.length === 0) { bouts.none++; return }
  const bout = hops[0].bout
  bouts[bout === WALK ? 'walk' : 'leap']++
  const D = Math.hypot(b.x - a.x, b.z - a.z)
  if (hops.length < bout.hops[0] || (hops.length < HOPS_MAX && D / hops.length > bout.m[1] * f.size + 1e-9)) badReach++
  const boutS = phrases.slice(1, -1).reduce((sum, ph) => sum + ph.dur, 0)
  const scaled = boutS < GRID_S - SIT_S[0] - 1e-9 ? false : true
  if (scaled) hurried++
  let prev = null
  for (let i = 1; i < phrases.length - 1; i++) {
    const ph = phrases[i]
    if (ph.kind === 'hop') {
      if (ph.bout !== bout || hopLen(ph) > 2 * (D / hops.length) + 1e-9 || !onBand(ph.to.x) || inRock(ph.to.x, ph.to.z)) badLanding++
      if (bout === WALK && prev) { walkPairs++; if (turn(bearing(ph) - bearing(prev)) < 2 * Math.atan(2 * Math.sin(WALK.turn)) + 1e-9) straight++ }
      prev = ph
    } else {
      const range = ph.at.wet ? WET_PAUSE_S : bout.pause
      if (ph.at.wet) wetPauses++
      if (ph.dur > range[1] + 1e-9 || (!scaled && ph.dur < range[0] - 1e-9)) { if (ph.at.wet) badWetPause++; else badPause++ }
    }
  }
}
const bearing = (ph) => Math.atan2(-(ph.to.z - ph.from.z), ph.to.x - ph.from.x)
const t0 = performance.now()
for (let i = 0; i < SECONDS / DT; i++) {
  const now = T0 + i * DT
  frogs.update(...HEAD, now)
  for (const f of alive()) {
    readSeg(f, now)
    if (f.state === 'hop') { hopped++; if (cameOut.has(f) && !f.ph.from.wet && !f.ph.to.wet) hoppedAfter.add(f) }
    if (f.state === 'sit' && f.wet) {
      afloat++
      wentIn.add(f)
      if (Math.abs(f.y - afloatY(f)) > 1e-6) afloatOff++
      if (f.nx !== 0 || f.ny !== 1 || f.nz !== 0) afloatTilted++
    }
    if (f.state === 'sit' && !f.wet && wentIn.has(f)) cameOut.add(f)
    if (!onBand(f.x)) offBand++
    if (inRock(f.x, f.z) && f.state === 'sit') onRock++
    const home = homes.get(f)
    if (home && f.state === 'sit') {
      const d = Math.hypot(f.x - home.x, f.z - home.z)
      if (d > maxStray) maxStray = d
      if (d > TETHER_M + LEAP.m[1] * f.size + 1e-9) strayed++
    }
  }
}
const ms = (performance.now() - t0) / (SECONDS / DT)
check(GRID_S === 8 && segs.size > alive().length * 6, 'every frog plans a segment each eight seconds of the room\'s clock', `${segs.size} segments for ${alive().length} frogs in ${SECONDS} s`)
check(badSeg === 0, 'a segment is a sit of SIT_S at its first post, the bout, and the sit that fills it at its next, GRID_S long from its grid turn', `${badSeg} off`)
check(badPost === 0, `a post is dry or within ${WADE_M} m of the bank afloat, on the band, off the boulder and within ${TETHER_M} m of home`, `${badPost} off`)
check(disjoint === 0 && offPost === 0, 'each segment takes up at the post the one before ended at, and the frog is there at the turn', `${disjoint} disjoint, ${offPost} off their post`)
check(hopped > 0, 'frogs hop', `${hopped} hop-frames`)
check(bouts.walk > bouts.leap && bouts.leap > 0, 'most bouts are walks, the rest leaps', `${bouts.walk} walks, ${bouts.leap} leaps, ${bouts.none} sat out`)
check(bouts.none < segs.size * 0.05, 'and hardly any segment is sat out for want of a way', `${bouts.none} of ${segs.size}`)
check(badReach === 0, `a walk's hops reach at most ${WALK.m[1]} body lengths and a leap's ${LEAP.m[1]}, and a bout has at least its hops`, `${badReach} off`)
check(badLanding === 0, 'every landing is on the band, off the boulder, and within twice the reach of the last', `${badLanding} off`)
check(walkPairs > 0 && straight === walkPairs, 'a walk\'s hops follow one another along its line', `${straight} of ${walkPairs} pairs within the wobble`)
check(badPause === 0, 'the beat between a bout\'s hops is the bout\'s own', `${badPause} off, ${hurried} bouts hurried to fit`)
check(TETHER_M === 4, 'the tether is four metres')
check(wentIn.size > 3 && afloat > 0 && wetPauses > 0, 'frogs land in the river', `${wentIn.size} went in over ${afloat} afloat frames, ${wetPauses} wet landings`)
check(afloatOff === 0 && afloatTilted === 0, 'a frog in the river floats half under the surface, level', `${afloatOff} off its level, ${afloatTilted} tilted`)
check(badWetPause === 0, `and rests there ${WET_PAUSE_S[0]}-${WET_PAUSE_S[1]} s before the next hop`, `${badWetPause} off`)
check(cameOut.size > 1 && hoppedAfter.size > 0, 'frogs come back onto the bank and hop on', `${cameOut.size} came out, ${hoppedAfter.size} hopped on land after`)
check(offBand === 0, 'no frog hops off the shore band', `${offBand} frames`)
check(onRock === 0, 'no frog sits on the boulder', `${onRock} frames`)
check(strayed === 0, `no frog ever rests more than ${TETHER_M} m and a leap from home`, `furthest ${maxStray.toFixed(2)} m`)
check(alive().every((f) => (f.state === 'sit' && !f.wet && Math.abs(f.y - (GROUND + 0.05)) < 1e-6) || (f.state === 'sit' && f.wet && Math.abs(f.y - afloatY(f)) < 1e-6) || f.state === 'hop'), 'a frog at rest is on the ground, or afloat at its level')
check(ms < 1.5, 'a frame costs well under a scatter', `${ms.toFixed(3)} ms/frame with ${alive().length} frogs`)
check(drawnCount() === alive().filter((f) => f.lod < LOD_TIERS).length && drawnCount() > 0, 'the tiers\' instance counts are the live frogs in view', `${drawnCount()} of ${alive().length} alive`)

// --- the room: two clients on different frames, and one joining late, have every frog in the same place ----
const poseOf = (f) => [f.key, f.x, f.y, f.z, f.yaw, f.nx, f.ny, f.nz, f.state, f.wet, f.u]
const poses = (layer) => layer.slots.filter((f) => f.tile !== null).map(poseOf).sort((a, b) => (a[0] < b[0] ? -1 : 1))
const same = (a, b) => a.length === b.length && a.every((p, i) => p.every((v, k) => (typeof v === 'number' ? Math.abs(v - b[i][k]) < 1e-9 : v === b[i][k])))
{
  const twin = new Frogs(new THREE.Scene(), height, water, { seed: 7, rocks, ground, assets: asset })
  twin.place(0, 0)
  // A client that has run since before the bed was grown, on a rougher, uneven frame.
  let t = T0 - 100
  while (t < T0 + SECONDS) { t += DT * (1 + 1.3 * Math.abs(Math.sin(t))); twin.update(...HEAD, Math.min(t, T0 + SECONDS)) }
  frogs.update(...HEAD, T0 + SECONDS)
  twin.update(...HEAD, T0 + SECONDS)
  check(same(poses(frogs), poses(twin)) && alive().length > 20, 'two clients on different frames have every frog in one pose', `${alive().length} frogs`)
  // And one that joins now, with no history, mid-segment for nearly every frog.
  const late = new Frogs(new THREE.Scene(), height, water, { seed: 7, rocks, ground, assets: asset })
  late.place(0, 0)
  late.update(...HEAD, T0 + SECONDS)
  check(same(poses(frogs), poses(late)), 'a client joining mid-segment has every frog where the others do')
  check(late.stats.segments === late.slots.filter((f) => f.tile !== null).length, 'and planned one segment a frog to get there', `${late.stats.segments} segments for ${alive().length} frogs`)
  // Ten seconds on -- past a turn for every frog -- still.
  for (let i = 1; i <= 10 / DT; i++) { frogs.update(...HEAD, T0 + SECONDS + i * DT); late.update(...HEAD, T0 + SECONDS + i * DT) }
  check(same(poses(frogs), poses(late)), 'and ten seconds on, past every frog\'s turn, still does')
  // Keys: the bed's tile and the frog's index, under the prefix the room routes here.
  check(alive().every((f) => f.key === keyOf(f.tile.tx, f.tile.tz, f.index) && f.key.startsWith(`${bedKey(f.tile.tx, f.tile.tz)}:`) && bedKey(f.tile.tx, f.tile.tz).startsWith('fg:')), 'a frog\'s key is its bed\'s and its index')
  check(alive().every((f) => f.offset === keyHash(f.key) % GRID_S) && new Set(alive().map((f) => f.offset)).size >= GRID_S - 3, 'each frog\'s grid is offset by the hash of its key, spread over the seconds', `${new Set(alive().map((f) => f.offset)).size} offsets`)
}
let NOW = T0 + SECONDS + 10

// --- breathing: a frog sitting out a long sit, her head over it, its instance's scale over one breath ----
{
  const sitter = alive().find((f) => f.state === 'sit' && !f.wet && f.ph.dur - f.t > BREATH_S + 0.2 && !f.live)
  check(sitter !== undefined, 'a frog is sitting out a breath\'s worth')
  const head = [sitter.x, sitter.y + 1.6, sitter.z]
  frogs.update(...head, NOW)
  const sy = [], sx = [], px = []
  for (let i = 0; i < Math.ceil(BREATH_S / DT); i++) {
    NOW += DT
    frogs.update(...head, NOW)
    const d = drawn(head).find((e) => e.f === sitter)
    const e = frogs.tiers[d.tier].instanceMatrix.array
    sx.push(Math.hypot(e[d.i * 16], e[d.i * 16 + 1], e[d.i * 16 + 2]))
    sy.push(Math.hypot(e[d.i * 16 + 4], e[d.i * 16 + 5], e[d.i * 16 + 6]))
    px.push(e[d.i * 16 + 12])
  }
  const swell = Math.max(...sy) / Math.min(...sy)
  const girth = Math.max(...sx) / Math.min(...sx)
  check(swell > 1 + BREATH_AMP * 0.8 && swell < 1 + BREATH_AMP * 1.2, 'a sitting frog swells and shrinks in height as it breathes', `height ${((swell - 1) * 100).toFixed(1)}% over ${BREATH_S} s`)
  check(girth > 1.005 && girth < swell, 'and rather less in girth', `girth ${((girth - 1) * 100).toFixed(1)}%`)
  check(px.every((x) => x === px[0]), 'without moving')
  const phases = new Set(alive().map((f) => f.breath.toFixed(3)))
  check(phases.size > alive().length * 0.8, 'each frog breathes on its own phase', `${phases.size} distinct of ${alive().length}`)
}

// --- bobbing: a frog resting in the river, her head over it, its instance's height over one bob ----
{
  let swimmer
  for (let i = 0; i < 120 / DT && !swimmer; i++) {
    NOW += DT
    frogs.update(...HEAD, NOW)
    swimmer = alive().find((f) => f.state === 'sit' && f.wet && f.ph.dur - f.t > BOB_S + 0.2)
  }
  check(swimmer !== undefined, 'a frog is resting in the river for a bob\'s worth')
  const head = [swimmer.x, swimmer.y + 1.6, swimmer.z]
  frogs.update(...head, NOW)
  const ys = []
  for (let i = 0; i < Math.ceil(BOB_S / DT); i++) {
    NOW += DT
    frogs.update(...head, NOW)
    const d = drawn(head).find((e) => e.f === swimmer)
    ys.push(frogs.tiers[d.tier].instanceMatrix.array[d.i * 16 + 13])
  }
  const span = Math.max(...ys) - Math.min(...ys)
  const level = afloatY(swimmer)
  check(BOB_S === 0.5 && BOB_AMP === 0.04, 'the bob is a half-second, four centimetres')
  check(span > BOB_AMP * 1.9 && span < BOB_AMP * 2.1 && Math.min(...ys) >= level - BOB_AMP - 1e-6 && Math.max(...ys) <= level + BOB_AMP + 1e-6, 'a floating frog bobs about its sunk level', `${(span * 100).toFixed(1)} cm peak to peak about ${level.toFixed(3)}, the surface at ${LEVEL}`)
  check(swimmer.y === level && swimmer.wet, 'its level held while it rests there')
}

// --- the drawn ground changing shape under the frogs -------------------------------
{
  // Frozen at a moment with frogs sitting, one afloat and one in the air.
  let flier, swimmer
  for (let i = 0; i < 120 / DT && !(flier && swimmer); i++) {
    NOW += DT
    frogs.update(...HEAD, NOW)
    flier = alive().find((f) => f.state === 'hop' && !f.ph.from.wet && !f.ph.to.wet)
    swimmer = alive().find((f) => f.state === 'sit' && f.wet)
  }
  check(flier !== undefined && swimmer !== undefined, 'a frog is in the air and one afloat')
  const sitters = alive().filter((f) => f.state === 'sit' && !f.wet)
  ground.lift = 0.25
  frogs.update(...HEAD, NOW)
  check(sitters.every((f) => Math.abs(f.y - (GROUND + 0.05)) < 1e-6) && Math.abs(flier.ph.to.y - (GROUND + 0.05)) < 1e-6, 'a moved surface with the same version is not re-read', `${sitters.length} sitting`)
  ground.groundVersion++
  frogs.update(...HEAD, NOW)
  check(sitters.every((f) => Math.abs(f.y - (GROUND + 0.25)) < 1e-6), 'the version ticking puts every sitting frog on the new surface', `${sitters.length} sitting`)
  check(Math.abs(flier.ph.from.y - (GROUND + 0.25)) < 1e-6 && Math.abs(flier.ph.to.y - (GROUND + 0.25)) < 1e-6, 'and a frog in the air will land on it')
  check(swimmer.y === afloatY(swimmer), 'while a frog afloat stays at its level in the water')
  ground.lift = 0.05
  ground.groundVersion++
  frogs.update(...HEAD, NOW)
  check(sitters.every((f) => Math.abs(f.y - (GROUND + 0.05)) < 1e-6), 'and back again when it drops')
}

// --- the ladder: each frog is the tier its distance calls for, in its own body lengths ----
{
  const span = (SIZE_M[0] + SIZE_M[1]) / 2
  const rungs = Array.from({ length: LOD_TIERS }, (_, k) => lodReach(span, k))
  check(LOD_TIERS === 4 && rungs.every((d, k) => k === 0 || Math.abs(d / rungs[k - 1] - 2) < 1e-12), `four tiers, each reaching twice as far as the one above it`, `${rungs.map((d) => d.toFixed(1)).join(' / ')} m for a ${span.toFixed(2)} m frog`)
  // critterTier on its own: the pick near, each tier one step down, nothing past the cull, and hysteresis both ways round a threshold.
  const ladder = rungs.map((d) => critterTier(span, d * 0.99, -1, LOD_TIERS))
  check(ladder.every((t, k) => t === k) && critterTier(span, 0.1, -1, LOD_TIERS) === 0 && critterTier(span, 1000, -1, LOD_TIERS) === LOD_TIERS, 'critterTier steps a frog with no tier yet down the ladder by its distance and off its foot', ladder.join(', '))
  // Around the tier 1 / tier 2 threshold.
  const edge = rungs[1]
  const H = LOD_HYSTERESIS
  const stayUp = critterTier(span, edge * (1 + H * 0.5), 1, LOD_TIERS), stayDown = critterTier(span, edge * (1 - H * 0.5), 2, LOD_TIERS)
  const goUp = critterTier(span, edge * (1 - H * 1.5), 2, LOD_TIERS), goDown = critterTier(span, edge * (1 + H * 1.5), 1, LOD_TIERS)
  check(stayUp === 1 && stayDown === 2 && goUp === 1 && goDown === 2, 'a frog just over a threshold keeps its tier until it is well over', `stay ${stayUp}/${stayDown}, go ${goUp}/${goDown}`)
  check(critterTier(span, 1000, LOD_TIERS - 1, LOD_TIERS) === LOD_TIERS && critterTier(span, cullRange(span) * 1.05, LOD_TIERS, LOD_TIERS) === LOD_TIERS, 'a frog past the cull is not drawn, and one just back inside it not drawn yet either')

  // In the scatter: her head on the bank, every drawn frog is in the tier its size over its distance calls for, and every frog past its cull is undrawn.
  frogs.place(0, 0)
  frogs.update(...HEAD, NOW)
  frogs.update(...HEAD, NOW)
  const list = drawn(HEAD)
  check(list.length > 0 && list.every((d) => d.f), 'every instance stands on some live frog\'s seat', `${list.length} drawn`)
  const tiersUsed = new Set(list.map((d) => d.tier))
  check(tiersUsed.size >= 3, 'the bank in view spans several tiers', `tiers ${[...tiersUsed].sort().join(', ')}`)
  const right = list.filter((d) => d.f && critterTier(d.f.size, d.dist, -1, LOD_TIERS) === d.tier).length
  check(right === list.length, 'each is drawn as the tier its distance calls for', `${right} of ${list.length}`)
  const away = (f) => Math.hypot(f.x - HEAD[0], f.y - HEAD[1], f.z - HEAD[2])
  const hidden = alive().filter((f) => f.lod === LOD_TIERS)
  check(hidden.length > 0 && hidden.every((f) => away(f) > cullRange(f.size) * (1 - H)) && list.every((d) => d.dist <= cullRange(d.f.size) * (1 + H)), 'the frogs past their own cull are not drawn, and every drawn one is inside it', `${hidden.length} hidden of ${alive().length}`)
  // A tier instance is its frog: same size (the matrix's scale up to the breath), same tint and hue. The buffers are float32.
  let matched = 0
  for (const d of list) {
    const mesh = frogs.tiers[d.tier]
    const e = mesh.instanceMatrix.array
    const sx = Math.hypot(e[d.i * 16], e[d.i * 16 + 1], e[d.i * 16 + 2]) * frogs.span
    const c = mesh.instanceColor.array
    const tint = Math.abs(c[d.i * 3] - d.f.r) < 1e-6 && Math.abs(c[d.i * 3 + 1] - d.f.g) < 1e-6 && Math.abs(c[d.i * 3 + 2] - d.f.b) < 1e-6
    if (Math.abs(sx / d.f.size - 1) < 0.3 && tint && Math.abs(frogs.hues[d.tier].array[d.i] - d.f.hue) < 1e-6) matched++
  }
  check(matched === list.length, 'each instance carries its frog\'s own matrix, tint and hue', `${matched} of ${list.length}`)
  // Her head swaying on a threshold, the clock held so the frog stays put: a frog there changes tier at most once, not every frame.
  const target = alive().find((f) => f.state === 'sit' && f.lod >= 0 && f.lod < LOD_TIERS - 1)
  if (!target) throw new Error('check-frogs: no drawn sitting frog with a rung below it to sway across')
  const dist0 = Math.hypot(target.x - HEAD[0], target.y - HEAD[1], target.z - HEAD[2])
  const edgeD = lodReach(target.size, target.lod)
  let changes = 0, prev = target.lod
  for (let i = 0; i < 200; i++) {
    // Along the line from her head to the frog, so the distance is exactly the threshold plus a sway of half the hysteresis.
    const sway = edgeD * (1 + Math.sin(i * 0.7) * H * 0.4)
    const t = 1 - sway / dist0
    frogs.update(HEAD[0] + (target.x - HEAD[0]) * t, HEAD[1] + (target.y - HEAD[1]) * t, HEAD[2] + (target.z - HEAD[2]) * t, NOW)
    if (target.lod !== prev) { changes++; prev = target.lod }
  }
  check(changes <= 1, 'a frog on a threshold does not flicker between tiers as her head sways', `${changes} tier changes over 200 frames`)
  // Walk her out to the far bank: what was undrawn is the pick.
  frogs.update(-HALF - 2, GROUND + 1.6, 40, NOW)
  frogs.update(-HALF - 2, GROUND + 1.6, 40, NOW)
  // Tier 0 reaches under two metres for a frog, so what says she has moved is which frogs are drawn at all, not which are on the near rung.
  const near = drawn([-HALF - 2, GROUND + 1.6, 40])
  check(near.length > 0 && near.every((d) => Math.hypot(d.p[0] - HEAD[0], d.p[2] - HEAD[2]) > 20), 'the frogs drawn are the ones by the bank she walked to, not the ones she left', `${near.length} drawn, none within 20 m of where she stood`)
}

// --- a bank that slopes: frogs sit along its normal, and turn to the new slope over a hop ----
{
  // The east bank rises 0.4 in x beyond SEAM, level nearer the water and on the west bank, so a hop across the seam changes the normal.
  const GX = 0.4
  const SEAM = HALF + 2
  const slope = { ...height, heightAndSlopeAt: (x) => (x > SEAM ? { h: GROUND, tan: GX, gx: GX, gz: 0 } : { h: GROUND, tan: 0, gx: 0, gz: 0 }) }
  const tilted = new Frogs(new THREE.Scene(), slope, water, { seed: 7, rocks, ground, assets: asset })
  tilted.place(0, 0)
  tilted.update(0, GROUND + 1.6, 0, NOW)
  const want = [-GX, 1, 0].map((c) => c / Math.hypot(GX, 1))
  const upOf = (mesh, i) => { const e = mesh.instanceMatrix.array; const y = [e[i * 16 + 4], e[i * 16 + 5], e[i * 16 + 6]]; const l = Math.hypot(...y); return y.map((c) => c / l) }
  const live = tilted.slots.filter((f) => f.tile !== null)
  const east = live.filter((f) => f.state === 'sit' && !f.wet && f.x > SEAM), west = live.filter((f) => f.state === 'sit' && !f.wet && f.x < SEAM)
  check(east.length >= 3 && east.every((f) => Math.hypot(f.nx - want[0], f.ny - want[1], f.nz - want[2]) < 1e-9), 'a frog on the sloped bank holds the ground normal', `${east.length} frogs, normal ${want.map((c) => c.toFixed(3))}`)
  check(west.length >= 3 && west.every((f) => f.nx === 0 && f.ny === 1 && f.nz === 0), 'and one on the level ground the world up')
  // The matrix's up column is that normal, on whichever tier the frog is drawn in.
  let tiltedOk = 0, tiltedN = 0
  for (const mesh of tilted.tiers) {
    for (let i = 0; i < mesh.count; i++) {
      const p = at(mesh, i)
      const f = live.find((g) => Math.abs(g.x - p[0]) < 1e-4 && Math.abs(g.z - p[2]) < 1e-4)
      const u = upOf(mesh, i)
      tiltedN++
      if (f && Math.hypot(u[0] - f.nx, u[1] - f.ny, u[2] - f.nz) < 1e-5) tiltedOk++
    }
  }
  check(tiltedN > 0 && tiltedOk === tiltedN, 'each instance matrix stands its frog up along its normal', `${tiltedOk} of ${tiltedN}`)
  // Run until some frogs have hopped across the seam: mid-hop the normal is between the two, on landing it is the new one.
  let crossed = 0, between = 0, landed = 0
  const flying = new Set()
  for (let step = 1; step < 6000 && crossed < 3; step++) {
    tilted.update(0, GROUND + 1.6, 0, NOW + step * DT)
    for (const f of live) {
      if (f.state === 'hop' && (f.ph.from.x > SEAM) !== (f.ph.to.x > SEAM)) {
        flying.add(f)
        if (f.u > 0.2 && f.u < 0.5 && f.ny < 1 && f.ny > want[1]) between++
      } else if (f.state === 'sit' && flying.delete(f)) {
        crossed++
        const n = f.x > SEAM ? want : [0, 1, 0]
        if (Math.hypot(f.nx - n[0], f.ny - n[1], f.nz - n[2]) < 1e-9) landed++
      }
    }
  }
  check(crossed >= 3 && landed === crossed, 'a frog hopping across the seam lands along the slope it lands on', `${landed} of ${crossed}`)
  check(between > 0, 'and turns toward it in the air', `${between} mid-hop frames between the two`)
}

// --- a lure: a spider in her hand has a frog chasing it, and the room hears which ------
{
  frogs.place(0, 0)
  // A twin client with no lure in it, to say where the frog would be on its plan.
  const twin = new Frogs(new THREE.Scene(), height, water, { seed: 7, rocks, ground, assets: asset })
  twin.place(0, 0)
  const step = (head, lures) => { NOW += DT; frogs.update(...head, NOW, lures); twin.update(...head, NOW) }
  step(HEAD)
  // A frog sitting on the east bank with a clear run north along it.
  const f = alive().filter((g) => g.state === 'sit' && !g.wet && g.x > HALF + 0.5 && g.x < HALF + 2 && !inRock(g.x, g.z) && Math.abs(g.z) < 20).sort((a, b) => Math.abs(a.z) - Math.abs(b.z))[0]
  check(f !== undefined, 'a frog sits on the east bank to be lured')
  const twinOf = () => twin.slots.find((g) => g.key === f.key)
  const spider = { kind: 'spider', x: f.x, y: GROUND + 1, z: f.z, by: null }
  const head = () => [spider.x, GROUND + 1.6, spider.z]
  const gap = () => Math.hypot(spider.x - f.x, spider.z - f.z)
  const run = (s, lures, seen = new Set()) => { for (let i = 0; i < s / DT; i++) { step(head(), lures); seen.add(f.state) } return seen }
  const onPlan = () => Math.abs(f.x - twinOf().x) < 1e-9 && Math.abs(f.z - twinOf().z) < 1e-9 && f.live === null
  // The lured sets owed for the frog's own bed; other frogs near the spider may have their beds' sets owed too.
  const setsFor = () => frogs.pendingLured([]).filter((set) => set[0] === f.tile.key)
  const names = (set) => set[3].includes(f.index)
  spider.z = f.z + LURE_M + 1
  run(2, [spider])
  check(!f.lured && onPlan(), `a spider ${LURE_M + 1} m off is nothing to a frog on its plan`)
  run(2, [{ kind: 'carrot', x: f.x, y: GROUND + 1, z: f.z + 1, by: null }])
  check(!f.lured && onPlan(), 'nor is a carrot a metre off: a frog wants a spider, a butterfly or a grasshopper', LURES.join(' '))
  check(setsFor().every((set) => !names(set)), 'and the room hears nothing of it')
  // Sitting, within LURE_M: it has it, its sit cut to NOTICE_S.
  for (let i = 0; i < 20 / DT && !(f.state === 'sit' && f.ph.dur - f.t > NOTICE_S + 0.2); i++) step(head(), [])
  spider.x = f.x; spider.z = f.z + LURE_M - 0.5
  step(head(), [spider])
  check(f.lured && f.lure === spider && f.live !== null && f.live.ph.kind === 'sit' && f.live.at + f.live.ph.dur - NOW <= NOTICE_S + 1e-9, `a spider inside ${LURE_M} m has it, and its sit is cut short`, `${(f.live.at + f.live.ph.dur - NOW).toFixed(2)} s left`)
  const owed = setsFor()
  check(owed.length === 1 && owed[0][1] === 'fg' && owed[0][2] === null && owed[0].length === 4 && names(owed[0]) && owed[0][3].every((i) => Number.isInteger(i)), 'the bed\'s lured set goes to the room: the bed, the layer, the frog\'s index, the sender left to the relay', JSON.stringify(owed))
  const headings = new Set()
  let hops = 0
  let was = f.state
  for (let i = 0; i < 10 / DT; i++) {
    step(head(), [spider])
    if (f.state === 'hop' && was !== 'hop') { hops++; headings.add(Math.round(f.yaw * 10)) }
    was = f.state
  }
  check(hops >= 8 && gap() < ORBIT_M + CHASE.m[1] * f.size && Math.hypot(f.x - twinOf().x, f.z - twinOf().z) > 1, `in ten seconds it hops up to the spider and about it, off its plan`, `${hops} hops, ${gap().toFixed(2)} m off, ${Math.hypot(f.x - twinOf().x, f.z - twinOf().z).toFixed(2)} m from its plan`)
  check(headings.size >= 5, 'on headings all over, since it hops across the spider as often as at it', `${headings.size} headings in ${hops} hops`)
  check(setsFor().every(names), 'the frog stays in every set its bed sends after')
  // Carried along the bank past the tether: the frog leaves its patch after it.
  spider.z = f.homeZ + TETHER_M + 2.5
  run(12, [spider])
  const stray = Math.hypot(f.x - f.homeX, f.z - f.homeZ)
  check(f.lured && stray > TETHER_M && gap() < 1.5, `carried ${TETHER_M + 2.5} m from its home, it follows off its ${TETHER_M} m tether`, `${stray.toFixed(2)} m from home, ${gap().toFixed(2)} m off the spider`)
  // The spider put away: it forgets, and rejoins its plan at a turn.
  step(head(), [])
  check(!f.lured && f.lure === null && f.live !== null && f.live.queue !== null, 'the spider put away, it forgets it and lays its way back')
  const until = f.live.until
  check(Math.abs(((until - f.offset) % GRID_S + GRID_S) % GRID_S) < 1e-9 && until >= NOW + REJOIN_MIN_S - DT - 1e-9 && until < NOW + REJOIN_MIN_S + GRID_S, `to the post of a segment turn at least ${REJOIN_MIN_S} s off`, `${(until - NOW).toFixed(2)} s`)
  const emptied = setsFor()
  check(emptied.length === 1 && !names(emptied[0]), 'and the room hears the frog out of the bed\'s set', JSON.stringify(emptied))
  let hopsBack = 0
  was = f.state
  while (NOW < until - DT / 2) { step(head(), []); if (f.state === 'hop' && was !== 'hop') hopsBack++; was = f.state }
  step(head(), [])
  check(hopsBack > 0 && f.live === null && onPlan(), 'at the turn it is on its plan again, where a client that never saw the spider has it', `${hopsBack} hops back, ${Math.hypot(f.x - twinOf().x, f.z - twinOf().z).toFixed(3)} m off it`)
  run(10, [])
  check(onPlan() && Math.hypot(f.x - f.homeX, f.z - f.homeZ) <= TETHER_M + LEAP.m[1] * f.size, 'and ten seconds on it is still on it, inside its tether', `${Math.hypot(f.x - f.homeX, f.z - f.homeZ).toFixed(2)} m from home`)
  // Carried further than LURE_FORGET_M in one bound, it is given up.
  spider.x = f.x; spider.z = f.z + 1; spider.kind = 'grasshopper'
  run(1, [spider])
  check(f.lured && f.lure === spider, 'a grasshopper a metre off has it again')
  spider.z = f.z + LURE_FORGET_M + 1
  run(1, [spider])
  check(!f.lured, `and ${LURE_FORGET_M + 1} m off in a bound, it is given up`)
  const brief = setsFor()
  check(brief.length === 2 && names(brief[0]) && !names(brief[1]), 'the room heard it had and then had not', JSON.stringify(brief))
  while (f.live !== null) step(head(), [])
  // A peer's lure: between LURE_M and LURE_FORGET_M it is nothing, unless the peer's lured set names the frog.
  const peer = { kind: 'spider', x: f.x, y: GROUND + 1, z: f.z + LURE_M + 2, by: 7 }
  frogs.pendingLured([])
  run(1, [peer])
  check(!f.lured && onPlan(), `a peer's spider ${LURE_M + 2} m off is nothing`)
  frogs.applyLured([f.tile.key, 'fg', 7, [f.index]])
  run(1, [peer])
  check(f.lured && f.lure === peer, 'but the peer\'s lured set naming the frog says its hand had it, and it is chasing here too')
  check(frogs.pendingLured([]).length === 0, 'and the room hears nothing from this client of a peer\'s lure')
  frogs.applyLured([f.tile.key, 'fg', 7, []])
  run(1, [])
  check(!f.lured && frogs.luredIn.size === 0, 'the peer\'s set emptied, it is forgotten')
  while (f.live !== null) step(head(), [])
  // A frog afloat with a spider held on the bank hops out of the river after it.
  let swimmer
  for (let i = 0; i < 120 / DT && !swimmer; i++) { step(HEAD, []); swimmer = alive().find((g) => g.state === 'sit' && g.wet && g.x > 0 && g.ph.dur - g.t > 0.5) }
  check(swimmer !== undefined, 'a frog rests in the river by the east bank')
  const bait = { kind: 'spider', x: HALF + 0.8, y: GROUND + 1, z: swimmer.z, by: null }
  const states = new Set()
  for (let i = 0; i < 15 / DT; i++) { step([bait.x, GROUND + 1.6, bait.z], [bait]); states.add(swimmer.state + (swimmer.wet ? '-wet' : '')) }
  check(states.has('hop') && swimmer.lured && !swimmer.wet && swimmer.x > HALF && Math.hypot(bait.x - swimmer.x, bait.z - swimmer.z) < 1, 'a frog afloat with a spider held on the bank hops out of the river and up to it', `${[...states].join(' ')}; at x ${swimmer.x.toFixed(2)}, ${Math.hypot(bait.x - swimmer.x, bait.z - swimmer.z).toFixed(2)} m off`)
  // A bed leaving with a frog her hand had: the room hears the set emptied.
  frogs.pendingLured([])
  const bed = swimmer.tile.key
  frogs.place(500, 0)
  const gone = frogs.pendingLured([]).filter((set) => set[0] === bed)
  check(gone.length === 1 && gone[0][3].length === 0, 'a bed leaving with a lured frog empties its set to the room', JSON.stringify(gone))
}

// Dry land far from any water: nothing.
frogs.place(500, 0)
frogs.update(500, GROUND, 0, NOW)
check(alive().length === 0 && drawnCount() === 0, 'no frogs away from water', `${alive().length} alive, ${drawnCount()} drawn`)

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
if (failures) process.exit(1)
