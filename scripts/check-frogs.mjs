// Node-side gates for the frogs (src/v2/render/frogs.js).
//
//   node scripts/check-frogs.mjs
//
// The scatter runs against a synthetic world: flat ground at y = 10 with a
// straight river along z at x = 0 (banks at |x| = 4), the snow line dropping to
// the ground for z > 60 (cold), and one boulder at (8, 0). Everything below is
// a way a frog can go wrong without anything throwing: a frog in the water, in
// the cold, on the boulder or past the shore band; a shore with the wrong
// number of frogs for the density; frogs all one size or one colour; a frog
// that hops off the band, that never hops, that drifts away from where it was
// placed; a frog that never goes into the river, or that goes in and never
// comes out, or that sits in it on the bed instead of the surface, or tilted,
// or does not bob there, or paddles all one way or hops in it as though it were
// land, or that comes out and never hops again; a frog that only ever leaps, a
// walk whose hops are leap-sized or wander off its line, or that has no beat
// between its hops; a scatter that is not the same twice, or that seats a frog
// in the water; a frog standing level on a slope, or still tilted to the slope
// it left after a hop; a frame that costs more than a
// scatter is allowed to; a frog drawn as a tier its apparent size does not
// call for, or drawn at all under the last rung, a tier that flickers as her
// head sways on a threshold, or a tier instance that is not its frog's own
// matrix, tint and hue.
// The shipped GLB and its ladder are checked for existence, shape and facing
// too, because the world loads them by name and hops them along +X.
//
// What this can NOT check: whether they look like frogs, or how the hop reads.
// That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import { Frogs, DENSITY, TILE, SHORE_M, SIZE_M, MAX, TETHER_M, BREATH_S, BREATH_AMP, BOB_S, BOB_AMP, WALK, LEAP, PADDLE, WET_ROUGHNESS, MORPHS, LOD_DEG } from '../src/v2/render/frogs.js'
import { CRITTER_GLB, GLINT, LOD_HYSTERESIS, critterLodUrl, critterTier } from '../src/v2/render/critters.js'
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
    for (let k = 1; k < LOD_DEG.length; k++) {
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
const asset = LOD_DEG.map((_, k) => boxAsset(LOD_DEG.length - k))

// --- construction and the shader hook -----------------------------------------
const scene = new THREE.Scene()
const frogs = new Frogs(scene, height, water, { seed: 7, rocks, ground, assets: asset })
check(frogs.loaded && frogs.tiers.length === LOD_DEG.length && frogs.tiers.every((t) => t.visible && t.parent === frogs.batch) && Math.abs(frogs.span - 1) < 1e-6, 'assets set: every tier visible in the batch, span 1', `span ${frogs.span}`)
check(frogs.tiers.every((t, k) => t.geometry.index.count === asset[k].idx.length && t.material === frogs.material), 'each tier wears its own geometry under the one material')
check(frogs.tiers.every((t) => t.instanceColor && t.instanceColor.isInstancedBufferAttribute), 'tint rides in instanceColor')
check(frogs.tiers.every((t, k) => t.geometry.getAttribute('aHue') === frogs.hues[k] && frogs.hues[k].isInstancedBufferAttribute) && frogs.mesh === frogs.tiers[0], 'hue rides in aHue on every tier')
{
  const shader = { vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <lights_fragment_end>\n' }
  frogs.material.onBeforeCompile(shader)
  // The hue turn: read per instance, carried across, and applied to the sampled map before it is lit.
  check(shader.vertexShader.includes('attribute float aHue;') && shader.vertexShader.includes('vHue = aHue;') && /<map_fragment>\n\{\n[^}]*cross\( hueK, diffuseColor\.rgb \)/.test(shader.fragmentShader), 'the hue turns the sampled colour after map_fragment')
  // The glint: a Standard at the hand-set wet roughness, no metalness, three's own roughness sampler left alone, the lobe scaled by GLINT.
  check(frogs.material.isMeshStandardMaterial && frogs.material.roughness === WET_ROUGHNESS && WET_ROUGHNESS > 0 && WET_ROUGHNESS < 1 && frogs.material.metalness === 0, 'a Standard material at WET_ROUGHNESS with no metalness', `${frogs.material.type} roughness ${frogs.material.roughness}`)
  check(shader.fragmentShader.includes('<roughnessmap_fragment>') && !shader.fragmentShader.includes('sampledDiffuseColor.a'), 'the colour alpha is not read as roughness')
  check(shader.fragmentShader.includes(`reflectedLight.directSpecular *= ${GLINT.toFixed(2)};`) && GLINT > 0 && GLINT < 1, 'the glint is scaled down after lights_fragment_end', `GLINT ${GLINT}`)
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

// --- the run ---------------------------------------------------------------------
const DT = 1 / 72
const SECONDS = 60
const homes = new Map(alive().map((f) => [f, { x: f.homeX, z: f.homeZ }]))
let hopped = 0
let offBand = 0
let onRock = 0
let strayed = 0
let maxStray = 0
// The water: frames sat in the river, of them off the surface or tilted, or sat on the bank flagged wet; the frogs that went in, that came back out, and that hopped on land again after; strokes begun on the water under a land bout or with a rise, and their headings by quadrant.
let satWet = 0, wetOff = 0, wetTilted = 0, dryFlaggedWet = 0, landBoutAfloat = 0, risenStroke = 0
const wentIn = new Set(), cameOut = new Set(), hoppedAfter = new Set()
const strokeQuadrants = new Set()
// The gait, read off each frog's transitions: a bout starts with a hop from a spent `hops` count.
const bouts = { walk: 0, leap: 0, paddle: 0 }
let badReach = 0, badPause = 0, walkPairs = 0, straight = 0
const last = new Map()
const turn = (a) => Math.abs(Math.atan2(Math.sin(a), Math.cos(a)))
const t0 = performance.now()
for (let i = 0; i < SECONDS / DT; i++) {
  frogs.update(0, GROUND + 1.6, 0, DT)
  for (const f of alive()) {
    const p = last.get(f)
    if (p && f.state === 'hop' && p.state !== 'hop') {
      const m = Math.hypot(f.x1 - f.x0, f.z1 - f.z0) / f.size
      if (m < f.bout.m[0] - 1e-6 || m > f.bout.m[1] + 1e-6) badReach++
      if (p.hops === 0) bouts[f.bout === WALK ? 'walk' : f.bout === LEAP ? 'leap' : 'paddle']++
      else if (f.bout === WALK) { walkPairs++; if (turn(f.yaw - p.yaw) < 0.6 + 1e-9) straight++ }
      if (f.wet0) {
        if (f.bout !== PADDLE) landBoutAfloat++
        if (f.wet1 && f.rise !== 0) risenStroke++
        strokeQuadrants.add(Math.floor(((f.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI / 2)))
      } else if (f.bout === PADDLE) landBoutAfloat++
      if (!f.wet0 && cameOut.has(f)) hoppedAfter.add(f)
    }
    if (p && f.state === 'sit' && p.state === 'hop' && f.hops > 0 && (f.left < f.bout.pause[0] - 1e-9 || f.left > f.bout.pause[1] + 1e-9)) badPause++
    last.set(f, { state: f.state, yaw: f.yaw, hops: f.hops })
    if (f.state === 'hop') hopped++
    if (f.state === 'sit') {
      if (Math.abs(f.x) < HALF) {
        satWet++
        wentIn.add(f)
        if (!f.wet || Math.abs(f.y - LEVEL) > 1e-6) wetOff++
        if (f.nx !== 0 || f.ny !== 1 || f.nz !== 0) wetTilted++
      } else {
        if (f.wet) dryFlaggedWet++
        if (wentIn.has(f)) cameOut.add(f)
      }
    }
    if (Math.abs(f.x) >= HALF + SHORE_M) offBand++
    if (inRock(f.x, f.z) && f.state === 'sit') onRock++
    const home = homes.get(f)
    if (home) {
      const d = Math.hypot(f.x - home.x, f.z - home.z)
      if (d > maxStray) maxStray = d
      if (d > TETHER_M + 1e-9) strayed++
    }
  }
}
const ms = (performance.now() - t0) / (SECONDS / DT)
check(hopped > 0, 'frogs hop', `${hopped} hop-frames`)
check(bouts.walk > bouts.leap && bouts.leap > 0, 'most land bouts are walks, the rest leaps', `${bouts.walk} walks, ${bouts.leap} leaps`)
check(badReach === 0, `a walk's hops are ${WALK.m[0]}-${WALK.m[1]} body lengths, a leap's ${LEAP.m[0]}-${LEAP.m[1]} and a paddle's ${PADDLE.m[0]}-${PADDLE.m[1]}`, `${badReach} off`)
check(walkPairs > 0 && straight / walkPairs > 0.7, 'a walk\'s hops follow one another along its line', `${straight} of ${walkPairs} pairs within the wobble`)
check(badPause === 0, 'the beat between a bout\'s hops is the bout\'s own', `${badPause} off`)
check(TETHER_M === 4, 'the tether is four metres')
check(wentIn.size > 3 && satWet > 0, 'frogs hop into the river', `${wentIn.size} went in over ${satWet} sat-wet frames`)
check(wetOff === 0 && wetTilted === 0, 'a frog in the river floats on the surface, level', `${wetOff} off the surface, ${wetTilted} tilted`)
check(dryFlaggedWet === 0, 'and one on the bank is dry', `${dryFlaggedWet} frames`)
check(bouts.paddle > 0 && landBoutAfloat === 0, 'afloat it paddles, and only afloat', `${bouts.paddle} paddle bouts, ${landBoutAfloat} bouts in the wrong medium`)
check(risenStroke === 0, 'a stroke across the water does not leave it', `${risenStroke} risen`)
check(strokeQuadrants.size === 4, 'the strokes go every way', `quadrants ${[...strokeQuadrants].sort().join(', ')}`)
check(cameOut.size > 1 && hoppedAfter.size > 0, 'frogs come back onto the bank and hop on', `${cameOut.size} came out, ${hoppedAfter.size} hopped on land after`)
check(offBand === 0, 'no frog hops off the shore band', `${offBand} frames`)
check(onRock === 0, 'no frog sits on the boulder', `${onRock} frames`)
check(strayed === 0, `no frog ever lands more than ${TETHER_M} m from home, afloat or ashore`, `furthest ${maxStray.toFixed(2)} m`)
check(alive().every((f) => f.state !== 'sit' || Math.abs(f.y - (f.wet ? LEVEL : GROUND + 0.05)) < 1e-6), 'a sitting frog is on the ground, or on the water')
check(ms < 1.5, 'a frame costs well under a scatter', `${ms.toFixed(3)} ms/frame with ${alive().length} frogs`)
check(drawnCount() === alive().filter((f) => f.lod < LOD_DEG.length).length && drawnCount() > 0, 'the tiers\' instance counts are the live frogs in view', `${drawnCount()} of ${alive().length} alive`)

// --- breathing: pin every frog sitting and watch instance 0's scale over one breath ----
{
  for (const f of alive()) { f.state = 'sit'; f.left = 1e9 }
  frogs.update(0, GROUND + 1.6, 0, DT)
  // Instance 0 of the first tier with anything in it; pinned and with her head still, it stays that frog.
  const e = frogs.tiers.find((t) => t.count > 0).instanceMatrix.array
  const sy = [], sx = [], px = []
  for (let i = 0; i < Math.ceil(BREATH_S / DT); i++) {
    frogs.update(0, GROUND + 1.6, 0, DT)
    sx.push(Math.hypot(e[0], e[1], e[2]))
    sy.push(Math.hypot(e[4], e[5], e[6]))
    px.push(e[12])
  }
  const swell = Math.max(...sy) / Math.min(...sy)
  const girth = Math.max(...sx) / Math.min(...sx)
  check(swell > 1 + BREATH_AMP * 0.8 && swell < 1 + BREATH_AMP * 1.2, 'a sitting frog swells and shrinks in height as it breathes', `height ${((swell - 1) * 100).toFixed(1)}% over ${BREATH_S} s`)
  check(girth > 1.005 && girth < swell, 'and rather less in girth', `girth ${((girth - 1) * 100).toFixed(1)}%`)
  check(px.every((x) => x === px[0]), 'without moving')
  const phases = new Set(alive().map((f) => f.breath.toFixed(3)))
  check(phases.size > alive().length * 0.8, 'each frog breathes on its own phase', `${phases.size} distinct of ${alive().length}`)
}

// --- bobbing: one frog set afloat, the rest pinned, and its instance's height watched over one bob ----
{
  // The frog nearest her head, moved into the river beside her so it is drawn as the pick.
  const swimmer = alive().sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0]
  const was = { x: swimmer.x, z: swimmer.z }
  swimmer.wet = true; swimmer.x = 1; swimmer.z = 1; swimmer.y = LEVEL
  frogs.update(0, GROUND + 1.6, 0, DT)
  const d = drawn([0, GROUND + 1.6, 0]).find((e) => e.f === swimmer)
  check(d !== undefined, 'the swimmer is drawn', `lod ${swimmer.lod}`)
  const e = frogs.tiers[d.tier].instanceMatrix.array
  const ys = []
  for (let i = 0; i < Math.ceil(BOB_S / DT); i++) {
    frogs.update(0, GROUND + 1.6, 0, DT)
    ys.push(e[d.i * 16 + 13])
  }
  const span = Math.max(...ys) - Math.min(...ys)
  check(span > BOB_AMP * 1.9 && span < BOB_AMP * 2.1 && Math.min(...ys) >= LEVEL - BOB_AMP - 1e-6 && Math.max(...ys) <= LEVEL + BOB_AMP + 1e-6, 'a floating frog bobs about the surface', `${(span * 100).toFixed(1)} cm peak to peak about ${LEVEL}`)
  check(swimmer.y === LEVEL, 'without its seat moving')
  swimmer.wet = false; swimmer.x = was.x; swimmer.z = was.z; swimmer.y = GROUND + 0.05
}

// --- the drawn ground changing shape under a seated frog -------------------------
{
  // Every frog ashore and pinned, but one afloat in the river and one caught mid-hop, its arc pinned by a long flight.
  for (const f of alive()) { f.state = 'sit'; f.left = 1e9; f.wet = false; f.y = GROUND + 0.05 }
  const [flier, swimmer] = alive()
  flier.state = 'hop'; flier.x0 = flier.x1 = flier.x; flier.z0 = flier.z1 = flier.z; flier.y0 = flier.y1 = GROUND + 0.05; flier.wet0 = flier.wet1 = false; flier.t = 0; flier.dur = 1e9; flier.rise = 0
  swimmer.wet = true; swimmer.y = LEVEL
  ground.lift = 0.25
  frogs.update(0, GROUND + 1.6, 0, DT)
  const sitters = alive().filter((f) => f !== flier && f !== swimmer)
  const before = sitters.map((f) => f.y)
  check(sitters.every((f, i) => f.y === before[i]) && Math.abs(flier.y1 - (GROUND + 0.05)) < 1e-6, 'a moved surface with the same version is not re-read', `${sitters.length} sitting`)
  ground.groundVersion++
  frogs.update(0, GROUND + 1.6, 0, DT)
  check(sitters.every((f) => Math.abs(f.y - (GROUND + 0.25)) < 1e-6), 'the version ticking puts every sitting frog on the new surface', `${sitters.length} sitting`)
  check(Math.abs(flier.y0 - (GROUND + 0.25)) < 1e-6 && Math.abs(flier.y1 - (GROUND + 0.25)) < 1e-6, 'and a frog in the air will land on it')
  check(swimmer.y === LEVEL, 'while a frog afloat stays on the water')
  ground.lift = 0.05
  ground.groundVersion++
  frogs.update(0, GROUND + 1.6, 0, DT)
  flier.state = 'sit'; flier.y = flier.y1
  swimmer.wet = false; swimmer.y = GROUND + 0.05
  check(alive().every((f) => Math.abs(f.y - (GROUND + 0.05)) < 1e-6), 'and back again when it drops')
}

// --- the ladder: each frog is the tier its apparent size calls for, none under the last rung ----
{
  const deg = (span, dist) => Math.atan2(span, dist) * 180 / Math.PI
  check(LOD_DEG.length === 4 && LOD_DEG.every((d, k) => k === 0 || d < LOD_DEG[k - 1]) && LOD_DEG[LOD_DEG.length - 1] === 0.75, 'four tiers, each holding down to a smaller angle, the last to three quarters of a degree', LOD_DEG.join(', '))
  // critterTier on its own: the pick near, each tier one step down, nothing under the last rung, and hysteresis both ways round a threshold.
  const span = (SIZE_M[0] + SIZE_M[1]) / 2
  const ladder = LOD_DEG.map((d) => critterTier(span, span / Math.tan(d * Math.PI / 180) * 0.99, -1, LOD_DEG))
  check(ladder.every((t, k) => t === k) && critterTier(span, 0.5, -1, LOD_DEG) === 0 && critterTier(span, 1000, -1, LOD_DEG) === LOD_DEG.length, 'critterTier steps a frog with no tier yet down the ladder by its apparent size and off its foot', ladder.join(', '))
  // Around the tier 1 / tier 2 threshold.
  const edge = span / Math.tan(LOD_DEG[1] * Math.PI / 180)
  const H = LOD_HYSTERESIS
  const stayUp = critterTier(span, edge * (1 + H * 0.5), 1, LOD_DEG), stayDown = critterTier(span, edge * (1 - H * 0.5), 2, LOD_DEG)
  const goUp = critterTier(span, edge * (1 - H * 1.5), 2, LOD_DEG), goDown = critterTier(span, edge * (1 + H * 1.5), 1, LOD_DEG)
  check(stayUp === 1 && stayDown === 2 && goUp === 1 && goDown === 2, 'a frog just over a threshold keeps its tier until it is well over', `stay ${stayUp}/${stayDown}, go ${goUp}/${goDown}`)
  check(critterTier(span, 1000, LOD_DEG.length - 1, LOD_DEG) === LOD_DEG.length && critterTier(span, span / Math.tan(LOD_DEG[LOD_DEG.length - 1] * 1.05 * Math.PI / 180), LOD_DEG.length, LOD_DEG) === LOD_DEG.length, 'a frog under the last rung is not drawn, and one just over it not yet')

  // In the scatter: her head on the bank, every drawn frog is in the tier its size over its distance calls for, and every frog under the last rung is undrawn.
  frogs.place(0, 0)
  const HEAD = [HALF + 1, GROUND + 1.6, 0]
  frogs.update(...HEAD, DT)
  frogs.update(...HEAD, DT)
  const list = drawn(HEAD)
  check(list.length > 0 && list.every((d) => d.f), 'every instance stands on some live frog\'s seat', `${list.length} drawn`)
  const tiersUsed = new Set(list.map((d) => d.tier))
  check(tiersUsed.size >= 3, 'the bank in view spans several tiers', `tiers ${[...tiersUsed].sort().join(', ')}`)
  const right = list.filter((d) => d.f && critterTier(d.f.size, d.dist, -1, LOD_DEG) === d.tier).length
  check(right === list.length, 'each is drawn as the tier its apparent size calls for', `${right} of ${list.length}`)
  const hidden = alive().filter((f) => f.lod === LOD_DEG.length)
  check(hidden.length > 0 && hidden.every((f) => deg(f.size, Math.hypot(f.x - HEAD[0], f.y - HEAD[1], f.z - HEAD[2])) < LOD_DEG[LOD_DEG.length - 1] * (1 + H)) && list.every((d) => deg(d.f.size, d.dist) >= LOD_DEG[LOD_DEG.length - 1] * (1 - H)), 'the frogs under the last rung are not drawn, and every drawn one is over it', `${hidden.length} hidden of ${alive().length}`)
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
  // Her head swaying on a threshold: a frog there changes tier at most once, not every frame.
  for (const f of alive()) { f.state = 'sit'; f.left = 1e9 }
  const target = alive().find((f) => f.lod === 1)
  const dist0 = Math.hypot(target.x - HEAD[0], target.y - HEAD[1], target.z - HEAD[2])
  const edgeD = target.size / Math.tan(LOD_DEG[1] * Math.PI / 180)
  let changes = 0, prev = target.lod
  for (let i = 0; i < 200; i++) {
    // Along the line from her head to the frog, so the distance is exactly the threshold plus a sway of half the hysteresis.
    const sway = edgeD * (1 + Math.sin(i * 0.7) * H * 0.4)
    const t = 1 - sway / dist0
    frogs.update(HEAD[0] + (target.x - HEAD[0]) * t, HEAD[1] + (target.y - HEAD[1]) * t, HEAD[2] + (target.z - HEAD[2]) * t, DT)
    if (target.lod !== prev) { changes++; prev = target.lod }
  }
  check(changes <= 1, 'a frog on a threshold does not flicker between tiers as her head sways', `${changes} tier changes over 200 frames`)
  // Walk her out to the far bank: what was undrawn is the pick.
  frogs.update(-HALF - 2, GROUND + 1.6, 40, DT)
  frogs.update(-HALF - 2, GROUND + 1.6, 40, DT)
  const near = drawn([-HALF - 2, GROUND + 1.6, 40]).filter((d) => d.tier === 0)
  check(near.length > 0 && near.every((d) => Math.hypot(d.p[0] - HEAD[0], d.p[2] - HEAD[2]) > 20), 'a frog she walks up to comes back as the pick', `${near.length} in the pick now`)
}

// --- a bank that slopes: frogs sit along its normal, and turn to the new slope over a hop ----
{
  // The east bank rises 0.4 in x beyond SEAM, level nearer the water and on the west bank, so a hop across the seam changes the normal.
  const GX = 0.4
  const SEAM = HALF + 2
  const slope = { ...height, heightAndSlopeAt: (x) => (x > SEAM ? { h: GROUND, tan: GX, gx: GX, gz: 0 } : { h: GROUND, tan: 0, gx: 0, gz: 0 }) }
  const tilted = new Frogs(new THREE.Scene(), slope, water, { seed: 7, rocks, ground, assets: asset })
  tilted.place(0, 0)
  tilted.update(0, GROUND + 1.6, 0, DT)
  const want = [-GX, 1, 0].map((c) => c / Math.hypot(GX, 1))
  const upOf = (mesh, i) => { const e = mesh.instanceMatrix.array; const y = [e[i * 16 + 4], e[i * 16 + 5], e[i * 16 + 6]]; const l = Math.hypot(...y); return y.map((c) => c / l) }
  const live = tilted.slots.filter((f) => f.tile !== null)
  const east = live.filter((f) => f.x > SEAM), west = live.filter((f) => f.x < SEAM)
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
  for (let step = 0; step < 6000 && crossed < 3; step++) {
    tilted.update(0, GROUND + 1.6, 0, DT)
    for (const f of live) {
      if (f.state === 'hop' && (f.x0 > SEAM) !== (f.x1 > SEAM)) {
        flying.add(f)
        const u = f.t / f.dur
        if (u > 0.2 && u < 0.5 && f.ny < 1 && f.ny > want[1]) between++
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

// Dry land far from any water: nothing.
frogs.place(500, 0)
frogs.update(500, GROUND, 0, DT)
check(alive().length === 0 && drawnCount() === 0, 'no frogs away from water', `${alive().length} alive, ${drawnCount()} drawn`)

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
if (failures) process.exit(1)
