// Node-side gates for the crabs (src/v2/render/crabs.js).
//
//   node scripts/check-crabs.mjs
//
// The scatter runs against a synthetic lake: a 30 m bowl of water at y = 12,
// eight metres deep in the middle, with a gentle bank rising away from the
// shore, and a handful of hemispherical boulders -- one on the lake floor, a
// small one beside it, one on the shelf, one on the beach with a cobble next to
// it, one too far up the bank, one far away.
// Everything below is a way a crab can go wrong without anything throwing: a
// crab on the terrain, in the air or inside a stone; a crab on a rock past the
// shore band or on one under a metre; beach crabs as big as the deep ones; a
// crab smaller than the floor or out of proportion to its rock; a crab that walks off its
// rock or never moves; a scatter that is not the same twice; a tile whose
// rocks landed late and never got its crabs; a frame that costs more than a
// scatter is allowed to; crabs all one colour; a far crab still drawn as the
// mesh, or a card that does not stand on its crab's stone at its crab's tilt
// and hue, that has no top to be seen from above, or that is dithered; a
// crab drawn as flat as its mesh or tiptoeing on the stone instead of sunk into
// it; a crab on a steep shoulder standing straight up because the far side of
// its footprint is off the stone, or one at the top of a face tipped over it.
// The shipped GLB is checked for existence and shape too, because the world
// loads it by name.
//
// What this can NOT check: whether they look like crabs, or how the scuttle
// reads. That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import { Crabs, SHORE_M, PERCH_MIN, SIZE_M, DEEP_MUL, ROCK_FRACTION, PER_PERCH, SPEED, STRETCH_Y, SINK, WET_ROUGHNESS, HUE, RESEAT_EVERY, RADIUS } from '../src/v2/render/crabs.js'
import { PERCH_STRIDE } from '../src/v2/render/rocks.js'
import { CARD_M, CRITTER_GLB, GLINT } from '../src/v2/render/critters.js'
import { TEX_PX_MAX, TEX_PX_SMALL } from '../tools/creatures/creature-roster.mjs'
import { webpSize } from '../tools/tripo-pack.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- the synthetic lake --------------------------------------------------------
const LEVEL = 12
const LAKE_R = 30
const DEEP = 8
const BANK_TAN = 0.2
const groundAt = (x, z) => {
  const d = Math.hypot(x, z)
  if (d < LAKE_R) { const r = d / LAKE_R; return LEVEL - DEEP * (1 - r * r) }
  return LEVEL + (d - LAKE_R) * BANK_TAN
}
const height = {
  heightAt: groundAt,
  heightAndSlopeAt(x, z) {
    const d = Math.hypot(x, z)
    return { h: groundAt(x, z), tan: d < LAKE_R ? (2 * DEEP * d) / (LAKE_R * LAKE_R) : BANK_TAN, gx: 0, gz: 0 }
  },
}
const water = {
  lakeLevelAt: (x, z) => (Math.hypot(x, z) < LAKE_R + 15 ? LEVEL : null),
  lakeShoreDistAt(x, z, reach) {
    if (!(reach > 0)) throw new Error('reach')
    const d = Math.hypot(x, z) - LAKE_R
    return d > reach ? reach : d < -reach ? -reach : d
  },
}

// Hemispheres seated at their centre's ground height; a rock's size is its width, 2r. `name` is for the report.
const BOULDERS = [
  { name: 'floor', x: 0, z: 0, r: 2 },
  { name: 'stone', x: 5, z: 5, r: 0.6 },
  { name: 'shelf', x: 20, z: 0, r: 2 },
  { name: 'beach', x: 33, z: 0, r: 1.5 },
  { name: 'cobble', x: 33, z: 4, r: 0.45 },
  { name: 'bank', x: 40, z: 0, r: 2 },
  { name: 'far', x: 70, z: 70, r: 3 },
]
for (const b of BOULDERS) b.y = groundAt(b.x, b.z)
const WANT = new Set(['floor', 'stone', 'shelf', 'beach'])
let live = []
// Every stone shifted by `lift`: a rock re-seated on the drawn terrain.
let lift = 0
const surfaceOf = (b, x, z) => {
  const d2 = (x - b.x) ** 2 + (z - b.z) ** 2
  return d2 < b.r * b.r ? b.y + lift + Math.sqrt(b.r * b.r - d2) : -Infinity
}
const rocks = {
  calls: 0,
  perchesInto(x0, z0, x1, z1, out) {
    let w = 0
    for (const b of live) {
      if (b.x < x0 || b.x >= x1 || b.z < z0 || b.z >= z1) continue
      const o = w * PERCH_STRIDE
      out[o] = b.x; out[o + 1] = b.y - 0.3; out[o + 2] = b.z; out[o + 3] = b.r * 1.1; out[o + 4] = 2 * b.r
      w++
    }
    return w
  },
  blockTopAt(x, z, minSize, settle) {
    this.calls++
    if (settle !== false) throw new Error('crabs must ask for the unsettled surface')
    let best = -Infinity
    for (const b of live) {
      if (2 * b.r < minSize) continue
      const s = surfaceOf(b, x, z)
      if (s > best) best = s
    }
    return best
  },
}
const stoneUnder = (c) => rocks.blockTopAt(c.x, c.z, PERCH_MIN, false)
const boulderOf = (c) => BOULDERS.find((b) => surfaceOf(b, c.x, c.z) > -Infinity)

// --- the shipped asset ---------------------------------------------------------
{
  const file = new URL(`../public/${CRITTER_GLB.crab}`, import.meta.url)
  check(fs.existsSync(file), `${CRITTER_GLB.crab} is shipped -- run tools/creatures/ship.mjs`)
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file)
    check(buf.toString('latin1', 0, 4) === 'glTF', 'the crab GLB has a glTF header')
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
  }
}

// --- a stand-in asset: a unit slab, feet at y = 0 ------------------------------
const box = new THREE.BoxGeometry(0.75, 0.3, 1).translate(0, 0.15, 0)
const asset = {
  pos: box.getAttribute('position').array,
  nrm: box.getAttribute('normal').array,
  uv: box.getAttribute('uv').array,
  idx: Array.from(box.index.array),
  map: null,
}

// --- construction and the shader hook -----------------------------------------
const scene = new THREE.Scene()
const crabs = new Crabs(scene, height, water, { seed: 11, rocks, assets: asset })
check(crabs.loaded && crabs.mesh.visible && Math.abs(crabs.span - 1) < 1e-6, 'asset set: visible, span 1', `span ${crabs.span}`)
{
  const shader = { vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <lights_fragment_end>\n' }
  crabs.material.onBeforeCompile(shader)
  check(shader.vertexShader.includes('attribute vec2 aLegs') && shader.vertexShader.includes('legW') && shader.vertexShader.includes('transformed.y +='), 'leg wiggle spliced into begin_vertex')
  check(crabs.mesh.geometry.getAttribute('aLegs').isInstancedBufferAttribute, 'aLegs is per instance')
  // The hue turn: read per instance on the mesh and the card, carried across, and applied to the sampled map before it is lit.
  check(crabs.mesh.geometry.getAttribute('aHue') === crabs.hue && crabs.hue.isInstancedBufferAttribute && crabs.card.geometry.getAttribute('aHue') === crabs.cardHue, 'hue rides in aHue on the mesh and the card')
  check(shader.vertexShader.includes('attribute float aHue;') && shader.vertexShader.includes('vHue = aHue;') && /<map_fragment>\n\{\n[^}]*cross\( hueK, diffuseColor\.rgb \)/.test(shader.fragmentShader), 'the hue turns the sampled colour after map_fragment')
  // The glint: a Standard at the hand-set wet roughness, no metalness, three's own roughness sampler left alone, the lobe scaled by GLINT.
  check(crabs.material.isMeshStandardMaterial && crabs.material.roughness === WET_ROUGHNESS && WET_ROUGHNESS > 0 && WET_ROUGHNESS < 1 && crabs.material.metalness === 0, 'a Standard material at WET_ROUGHNESS with no metalness', `${crabs.material.type} roughness ${crabs.material.roughness}`)
  check(shader.fragmentShader.includes('<roughnessmap_fragment>') && !shader.fragmentShader.includes('sampledDiffuseColor.a'), 'the colour alpha is not read as roughness')
  check(shader.fragmentShader.includes(`reflectedLight.directSpecular *= ${GLINT.toFixed(2)};`) && GLINT > 0 && GLINT < 1, 'the glint is scaled down after lights_fragment_end', `GLINT ${GLINT}`)
}

// --- placement -----------------------------------------------------------------
// A perch carries PER_PERCH * (1 + rand * r^2) crabs on average, so any one rock may
// have none; the placement checks pool SEEDS worlds' worth so each boulder is judged
// on its expectation, and every crab in the pool on its own terms.
const alive = (of = crabs) => of.slots.filter((c) => c.perch !== null)
live = BOULDERS
const SEEDS = 16
const pool = []
for (let seed = 1; seed <= SEEDS; seed++) {
  const k = new Crabs(scene, height, water, { seed, rocks, assets: asset })
  k.place(15, 0)
  check(k.overflow === 0 && k.saturated === 0, `seed ${seed}: nothing was dropped for want of room`)
  for (const c of alive(k)) pool.push({ x: c.x, y: c.y, z: c.z, size: c.size, hue: c.hue, depth: c.depth })
  k.dispose()
}
crabs.place(15, 0)
{
  const all = pool
  check(all.length >= 4 * SEEDS, 'the lake\'s boulders carry crabs', `${all.length} over ${SEEDS} seeds; one seed: ${JSON.stringify(crabs.stats)}`)
  const homes = all.map(boulderOf)
  check(homes.every((b) => b && WANT.has(b.name)), 'every crab is on a lake-floor, shelf or beach boulder', [...new Set(homes.map((b) => b?.name ?? 'none'))].join(', '))
  const bank = BOULDERS.find((b) => b.name === 'bank')
  check(!homes.some((b) => b.name === 'bank'), `the boulder ${bank.x - LAKE_R} m up the bank has none (band is ${SHORE_M} m)`)
  const cobble = BOULDERS.find((b) => b.name === 'cobble')
  check(!homes.some((b) => b.name === 'cobble'), `the ${2 * cobble.r} m cobble on the beach has none (a perch is ${PERCH_MIN} m)`)
  // The stub's hull radius is 1.1 r, and none of these is big enough for PERCH_CAP to bind.
  for (const b of BOULDERS.filter((b) => WANT.has(b.name))) {
    const got = homes.filter((h) => h === b).length / SEEDS
    const want = PER_PERCH * (1 + 0.5 * (1.1 * b.r) ** 2)
    check(got > want * 0.65 && got < want * 1.35, `the ${2 * b.r} m ${b.name} boulder carries about ${want.toFixed(2)} crabs`, `${got.toFixed(2)} a seed`)
  }
  check(all.every((c) => Math.abs(c.y - stoneUnder(c)) < 1e-6), 'every crab sits on the stone\'s own surface', `${all.length} crabs`)
  check(all.every((c) => c.y > groundAt(c.x, c.z)), 'no crab is on or under the terrain')
  const mean = (name) => { const s = all.filter((c) => boulderOf(c).name === name).map((c) => c.size); return s.reduce((a, b) => a + b, 0) / s.length }
  const floor = mean('floor'), shelf = mean('shelf'), beach = mean('beach'), stone = mean('stone')
  check(floor > beach * 1.5 && beach <= SIZE_M[1] && floor <= SIZE_M[1] * DEEP_MUL, 'deep water makes larger crabs', `floor ${floor.toFixed(3)} m, shelf ${shelf.toFixed(3)} m, beach ${beach.toFixed(3)} m`)
  check(all.every((c) => c.size >= SIZE_M[0] - 1e-6), `no crab is under ${SIZE_M[0]} m`, `${Math.min(...all.map((c) => c.size)).toFixed(3)} m`)
  const capOf = (b) => Math.max(SIZE_M[0], ROCK_FRACTION * 2 * b.r)
  check(all.every((c) => c.size <= capOf(boulderOf(c)) + 1e-6), `no crab is over ${ROCK_FRACTION * 100}% of its rock's width, unless that is under the floor`)
  const floorB = BOULDERS.find((b) => b.name === 'floor')
  check(Math.abs(Math.max(...all.filter((c) => boulderOf(c) === floorB).map((c) => c.size)) - capOf(floorB)) < 1e-6, `the ${2 * floorB.r} m floor boulder's biggest crab is exactly its ${ROCK_FRACTION * 100}%`, `${capOf(floorB).toFixed(3)} m at ${DEEP} m of water`)
  check(Math.abs(stone - SIZE_M[0]) < 1e-6 && stone < floor, `the ${2 * BOULDERS[1].r} m floor stone's crabs are all the floor size: its 20% would be smaller`, `stone ${stone.toFixed(3)} m, floor ${floor.toFixed(3)} m`)
  check(all.filter((c) => boulderOf(c).name === 'floor').every((c) => c.y < LEVEL), 'lake-floor crabs are under the water')
  const sizes = all.map((c) => c.size)
  check(Math.max(...sizes) - Math.min(...sizes) > 0.05, 'sizes vary', `${Math.min(...sizes).toFixed(3)}..${Math.max(...sizes).toFixed(3)} m`)
  const hues = all.map((c) => c.hue)
  check(new Set(hues.map((h) => h.toFixed(3))).size > all.length * 0.8 && Math.min(...hues) < -HUE * 0.5 && Math.max(...hues) > HUE * 0.5 && hues.every((h) => Math.abs(h) <= HUE), 'hues vary either way round the wheel, within HUE', `${Math.min(...hues).toFixed(2)}..${Math.max(...hues).toFixed(2)} rad`)
}
// Determinism: the same rocks, the same crabs.
const snapA = alive().map((c) => [c.x, c.z, c.size]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
crabs.place(200, 200)
check(alive().length === 0, 'nothing away from the lake')
{
  // The first frame empties the buffers; after that a frame with no crab uploads nothing.
  for (let i = 0; i < 2; i++) crabs.update(200, LEVEL + 1.6, 200, 1 / 72)
  const versions = () => [crabs.mesh.instanceMatrix.version, crabs.legs.version, crabs.hue.version, crabs.card.instanceMatrix.version, crabs.cardHue.version].join(',')
  const v0 = versions()
  for (let i = 0; i < 72; i++) crabs.update(200, LEVEL + 1.6, 200, 1 / 72)
  check(versions() === v0 && crabs.mesh.count === 0, 'and a second of frames there re-uploads no buffer', `versions ${v0}`)
}
crabs.place(15, 0)
const snapB = alive().map((c) => [c.x, c.z, c.size]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
check(JSON.stringify(snapA) === JSON.stringify(snapB), 'placement is a pure function of the rocks', `${snapA.length} crabs`)

// --- the run -------------------------------------------------------------------
const DT = 1 / 72
const SECONDS = 60
const start = new Map(alive().map((c) => [c, { x: c.x, z: c.z }]))
let offStone = 0
let floating = 0
let offPerch = 0
let tilted = 0
let moved = 0
const paces = []
const lastPace = new Map()
rocks.calls = 0
const t0 = performance.now()
for (let i = 0; i < SECONDS / DT; i++) {
  crabs.update(15, LEVEL + 1.6, 0, DT)
  for (const c of alive()) {
    const top = stoneUnder(c)
    if (top === -Infinity) offStone++
    else if (Math.abs(c.y - top) > 1e-6) floating++
    if (Math.hypot(c.x - c.perch.x, c.z - c.perch.z) > c.perch.r + 1e-6) offPerch++
    if (c.ny < 0.999) tilted++
    // One sample per spell: a spell is a new pace on a crab.
    if (c.state === 'go' && c.speed !== lastPace.get(c)) { paces.push(c.speed); lastPace.set(c, c.speed) }
  }
}
const ms = (performance.now() - t0) / (SECONDS / DT)
for (const [c, s] of start) if (Math.hypot(c.x - s.x, c.z - s.z) > 0.05) moved++
check(offStone === 0, 'no crab ever leaves the stone', `${offStone} frames`)
check(floating === 0, 'no crab ever floats above or sinks into it', `${floating} frames`)
check(offPerch === 0, 'no crab leaves its own rock\'s disc', `${offPerch} frames`)
check(moved > alive().length * 0.5, 'crabs crawl about', `${moved} of ${alive().length} moved`)
check(tilted > 0, 'crabs ride the stone\'s slope', `${tilted} tilted frames`)
{
  const slow = paces.filter((p) => p < SPEED[0] * 3).length / paces.length
  const dash = paces.filter((p) => p > SPEED[1] * 0.6).length / paces.length
  check(slow > 0.25 && dash > 0.05 && dash < slow, 'the pace varies spell to spell, mostly a slow crawl with the odd dash', `${(slow * 100).toFixed(0)}% under ${(SPEED[0] * 3).toFixed(2)} spans/s, ${(dash * 100).toFixed(0)}% over ${(SPEED[1] * 0.6).toFixed(2)}, of ${paces.length} samples`)
}
check(ms < 1.5, 'a frame costs well under a scatter', `${ms.toFixed(3)} ms/frame, ${(rocks.calls / (SECONDS / DT)).toFixed(1)} surface queries/frame`)
check(crabs.mesh.count === alive().length && crabs.card.count === 0, 'the instance count is the live count, and before the bake all of it is the mesh', `${crabs.mesh.count}`)

// --- the stone moving under a seated crab ----------------------------------------
// A rock re-seated on a re-split chunk drops or rises by more than a crab may step; a crab follows within RESEAT_EVERY frames either way, pausing or walking.
{
  const seated = () => alive().filter((c) => Math.abs(c.y - stoneUnder(c)) < 1e-6).length
  const n = alive().length
  const [walker, pauser] = alive()
  walker.state = 'go'; walker.left = 10; walker.speed = SPEED[0]
  pauser.state = 'pause'; pauser.left = 10
  for (const shift of [-0.45, 0.45]) {
    lift += shift
    check(seated() < n * 0.5, `the stone ${shift < 0 ? 'drops' : 'rises'} ${Math.abs(shift)} m and the crabs are left ${shift < 0 ? 'in the air' : 'in the stone'}`, `${seated()} of ${n} seated`)
    for (let i = 0; i < RESEAT_EVERY; i++) crabs.update(15, LEVEL + 1.6, 0, DT)
    check(seated() === n, `every crab is back on the stone within ${RESEAT_EVERY} frames, the walker (whose step is refused as a ledge) and the pauser alike`, `${seated()} of ${n}`)
  }
  check(lift === 0 && seated() === n, 'and on it again once the stone is back')
}

// --- the ear hears the crabs -----------------------------------------------------
// bodies() is what the ambience reads for the crawl loop: the slots themselves, `speed > 0` on the ones on the move, a pause at speed 0.
{
  const [walker, pauser] = alive()
  walker.state = 'go'; walker.left = 10; walker.speed = SPEED[0]
  pauser.state = 'pause'; pauser.left = 10; pauser.speed = 0
  const listed = crabs.bodies([])
  check(listed.length === alive().length && listed.includes(walker) && walker.speed > 0, 'every seated crab is listed, the walker at its pace', `${listed.length} of ${alive().length}`)
  check(listed.includes(pauser) && pauser.speed === 0, 'the pauser listed at speed 0')
  walker.left = 0
  crabs.update(15, LEVEL + 1.6, 0, DT)
  check(walker.state === 'pause' && walker.speed === 0 && crabs.bodies([]).includes(walker), 'its spell over, the walker pauses at speed 0 and stays listed')
  crabs.batch.visible = false
  check(crabs.bodies([]).length === 0, 'a hidden layer lists nobody')
  crabs.batch.visible = true
}

// --- the drawn pose: stretched, and sunk into the stone along its normal --------
// The stand-in slab is 0.3 tall at span 1, so a crab sinks SINK * 0.3 * size.
const sinkOf = (c) => SINK * 0.3 * c.size
{
  const e = crabs.mesh.instanceMatrix.array
  let seated = 0, stretched = 0
  alive().forEach((c, i) => {
    const s = sinkOf(c)
    const off = Math.hypot(e[i * 16 + 12] - (c.x - c.nx * s), e[i * 16 + 13] - (c.y - c.ny * s), e[i * 16 + 14] - (c.z - c.nz * s))
    if (off < 1e-4) seated++
    const sx = Math.hypot(e[i * 16], e[i * 16 + 1], e[i * 16 + 2])
    const sy = Math.hypot(e[i * 16 + 4], e[i * 16 + 5], e[i * 16 + 6])
    if (Math.abs(sx - c.size) < 1e-4 && Math.abs(sy / sx - STRETCH_Y) < 1e-4) stretched++
  })
  check(seated === alive().length, `each crab is drawn ${SINK * 100}% of its body height into the stone along its own normal`, `${seated} of ${alive().length}`)
  check(stretched === alive().length, `each crab is drawn ${STRETCH_Y}x taller than its mesh, its footprint its size`, `${stretched} of ${alive().length}`)
}

// --- cling: the normal on a shoulder, at a lip, on a face -----------------------
{
  const shelf = BOULDERS.find((b) => b.name === 'shelf')
  // Low on the shelf's lakeward flank the outer sample is off the stone; the inner one alone must tip the crab outward, toward the lake.
  const c = { x: shelf.x - 1.96, z: shelf.z, size: 0.3 }
  c.y = surfaceOf(shelf, c.x, c.z)
  crabs._normal(c)
  check(c.nx < -0.8 && c.ny < 0.45 && Math.abs(c.nz) < 1e-6, 'a crab on a steep shoulder clings to it, even with the stone gone on its far side', `normal (${c.nx.toFixed(2)}, ${c.ny.toFixed(2)}, ${c.nz.toFixed(2)})`)
  const top = { x: shelf.x, z: shelf.z, y: shelf.y + shelf.r, size: 0.3 }
  crabs._normal(top)
  check(Math.abs(top.ny - 1) < 1e-6, 'a crab on the crown stands straight up', `ny ${top.ny.toFixed(4)}`)
  const e = 0.075
  check(crabs._slope(5, 5, -Infinity, e) === 0, 'a crab at the edge of a flat top, nothing beyond, stands flat')
  check(crabs._slope(5, 5, 0, e) === 0, 'a crab at the top of a face stands on the top, not tipped over the drop')
  check(crabs._slope(5, 5, 10, e) === 0, 'a crab at the foot of a face stands on the floor, not tipped against the wall')
  check(Math.abs(crabs._slope(4.7, 5, 5.3, e) - 4) < 1e-9, 'a crab on a face reads the face\'s own slope', `${crabs._slope(4.7, 5, 5.3, e)}`)
  check(crabs._slope(-Infinity, 5, -Infinity, e) === 0, 'stone gone on both sides is level')
}

// --- the cross card: far crabs leave the mesh for the card, under the same matrix ----
{
  check(crabs.card.parent === crabs.batch && !crabs.card.visible && crabs.card.geometry.index.count === 12, 'the card mesh rides in the batch, hidden until its picture is baked, two quads')
  // A crab is seen clinging to a rock from above, so its card is its side (upright on the XY plane, feet down) crossed with its TOP: a quad lying flat at the body's middle, the body's length by its breadth, reading the right half of the picture.
  {
    const pos = crabs.card.geometry.getAttribute('position'), uv = crabs.card.geometry.getAttribute('uv')
    const sideY = [0, 1, 2, 3].map((i) => pos.getY(i)), topY = [4, 5, 6, 7].map((i) => pos.getY(i))
    const topX = [4, 5, 6, 7].map((i) => pos.getX(i)), topZ = [4, 5, 6, 7].map((i) => pos.getZ(i))
    const { halfX, halfZ, height } = crabs.bounds
    check([0, 1, 2, 3].every((i) => pos.getZ(i) === 0) && Math.min(...sideY) < 0 && Math.max(...sideY) > height, 'the side quad stands upright on the body\'s length')
    check(topY.every((y) => Math.abs(y - height / 2) < 1e-6) && Math.min(...topX) < -halfX && Math.max(...topX) > halfX && Math.min(...topZ) < -halfZ && Math.max(...topZ) > halfZ && new Set(topX).size === 2 && new Set(topZ).size === 2, 'the other quad lies flat at the body\'s middle, the body\'s length by its breadth: the top', `y ${topY[0].toFixed(3)} of ${height.toFixed(3)}`)
    check([4, 5, 6, 7].every((i) => uv.getX(i) >= 0.5) && [0, 1, 2, 3].every((i) => uv.getX(i) <= 0.5), 'the side reads the left half of the picture, the top the right')
  }
  const shader = { vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <clipping_planes_fragment>\n#include <map_fragment>\n#include <normal_fragment_begin>' }
  crabs.cardMaterial.onBeforeCompile(shader)
  check(!/discard/.test(shader.fragmentShader) && crabs.cardMaterial.alphaTest === 0.5, 'the card is a cutout drawn whole, not dithered')
  check(crabs.cardMaterial.customProgramCacheKey() !== crabs.material.customProgramCacheKey(), 'the card compiles its own program')
  // Pooled over seeds again, so both sides of the line are populated: the shelf is a few metres from her, the floor and the beach well past CARD_M.
  const HEAD = [15, LEVEL + 1.6, 0]
  const dist = (e, i) => Math.hypot(e[i * 16 + 12] - HEAD[0], e[i * 16 + 13] - HEAD[1], e[i * 16 + 14] - HEAD[2])
  let meshN = 0, cardN = 0, liveN = 0, matched = 0
  const near = [], far = []
  for (let seed = 1; seed <= SEEDS; seed++) {
    const k = new Crabs(scene, height, water, { seed, rocks, assets: asset })
    k.setCard(null)
    k.place(15, 0)
    k.update(...HEAD, DT)
    const e = k.mesh.instanceMatrix.array, ce = k.card.instanceMatrix.array
    for (let i = 0; i < k.mesh.count; i++) near.push(dist(e, i))
    for (let i = 0; i < k.card.count; i++) {
      far.push(dist(ce, i))
      // The card stands where its crab stands, sunk the same way, on the crab's own normal.
      const c = alive(k).find((c) => Math.abs(c.x - c.nx * sinkOf(c) - ce[i * 16 + 12]) < 1e-4 && Math.abs(c.z - c.nz * sinkOf(c) - ce[i * 16 + 14]) < 1e-4)
      if (!c) continue
      const up = new THREE.Vector3(ce[i * 16 + 4], ce[i * 16 + 5], ce[i * 16 + 6]).normalize()
      if (Math.abs(up.x - c.nx) < 1e-5 && Math.abs(up.y - c.ny) < 1e-5 && Math.abs(up.z - c.nz) < 1e-5 && Math.abs(up.length() - 1) < 1e-5 && Math.abs(k.cardHue.array[i] - c.hue) < 1e-6) matched++
    }
    meshN += k.mesh.count; cardN += k.card.count; liveN += alive(k).length
    k.dispose()
  }
  check(meshN + cardN === liveN && meshN > 0 && cardN > 0, 'the mesh and the card together hold every crab', `${meshN} mesh, ${cardN} card, ${liveN} alive over ${SEEDS} seeds`)
  check(near.every((d) => d <= CARD_M) && far.every((d) => d > CARD_M), `the mesh holds the crabs within ${CARD_M} m of her head and the card the rest`, `mesh to ${Math.max(...near).toFixed(2)} m, card from ${Math.min(...far).toFixed(2)} m`)
  check(matched === cardN, 'each card stands where its crab stands, tilted to its stone, in its crab\'s hue', `${matched} of ${cardN}`)
}

// --- rocks that land late ------------------------------------------------------
live = []
crabs.place(15, 0)
check(alive().length === 0, 'no rocks, no crabs')
live = BOULDERS
for (let i = 0; i < 400; i++) crabs.update(15, LEVEL + 1.6, 0, DT)
check(alive().length === snapA.length, 'a tile whose rocks landed after the scan gets its crabs on the rescan', `${alive().length} of ${snapA.length}`)

// --- from above the surface, a sunk crab is neither drawn nor stepped ----------
{
  // The first seed that puts a crab on the floor stone AND one on the beach.
  let k = null
  for (let seed = 1; seed <= 16 && !k; seed++) {
    const t = new Crabs(scene, height, water, { seed, rocks, assets: asset })
    t.place(15, 0)
    if (alive(t).some((c) => c.y < c.perch.level) && alive(t).some((c) => !(c.y < c.perch.level))) k = t
    else t.dispose()
  }
  check(k !== null, 'some seed seats crabs both under the lake and on its beach')
  const written = () => k.mesh.count + k.card.count
  const sunk = alive(k).filter((c) => c.y < c.perch.level)
  const dry = alive(k).filter((c) => !(c.y < c.perch.level))
  check(sunk.every((c) => c.y < LEVEL) && dry.every((c) => c.y >= LEVEL), 'every crab knows its lake level, and whether it is under it', `${sunk.length} sunk, ${dry.length} dry`)
  const pose = sunk.map((c) => [c, c.x, c.y, c.z, c.left, c.phase])
  for (let i = 0; i < 5 * 72; i++) k.update(15, LEVEL + 1.6, 0, DT, false)
  check(written() === dry.length, 'with her head in the air only the dry crabs are written', `${written()} of ${alive(k).length}`)
  check(pose.every(([c, x, y, z, left, phase]) => c.x === x && c.y === y && c.z === z && c.left === left && c.phase === phase), 'and no sunk crab moves or counts the time')
  check(k.bodies([]).length === dry.length && !k.bodies([]).some((c) => sunk.includes(c)), 'and the ear is offered the dry crabs alone', `${k.bodies([]).length} listed`)
  for (let i = 0; i < 5 * 72; i++) k.update(15, LEVEL - 1, 0, DT, true)
  check(written() === alive(k).length, 'under, every crab is written again', `${written()} of ${alive(k).length}`)
  check(pose.some(([c, x, y, z, left]) => c.left !== left), 'and the sunk ones pick up where they paused')
  check(k.bodies([]).length === alive(k).length, 'and the ear is offered all of them')
  k.dispose()
}

// --- her hand: a crab taken, the perch never regrowing it, one let go of scuttling off --
{
  live = BOULDERS
  // The first seed with a crab on the beach.
  let k = null
  let seed = 0
  while (!k && ++seed <= 16) {
    const t = new Crabs(scene, height, water, { seed, rocks, assets: asset })
    t.place(15, 0)
    if (alive(t).some((c) => c.y >= LEVEL)) k = t
    else t.dispose()
  }
  check(k !== null, 'some seed seats a crab on the beach', `seed ${seed}`)
  const head = { x: 15, y: LEVEL + 1.6, z: 0, yaw: 0 }
  k.update(head.x, head.y, head.z, DT, false)
  const dry = alive(k).filter((c) => c.y >= LEVEL)
  const c = dry[0]
  const perch = c.perch
  const before = alive(k).length
  const hit = k.pickAt(c.x, c.y + 0.1, c.z, 0.3, 2)
  check(hit !== null && hit.c === c && hit.size === c.size, 'pickAt finds the crab under the hand', hit ? `${hit.dist.toFixed(3)} m` : 'null')
  check(k.pickAt(c.x, c.y + 0.1, c.z, 0.3, c.size) === null || k.pickAt(c.x, c.y + 0.1, c.z, 0.3, c.size).c !== c, 'and passes over one at the size cap')
  const sunk = alive(k).find((g) => g.y < LEVEL)
  check(!sunk || k.pickAt(sunk.x, sunk.y, sunk.z, 0.3, 2) === null, 'a sunk crab is not picked from the air')
  const rec = k.take(hit, 1)
  check(rec.kind === 'crab' && rec.size === c.size && rec.geometry === k.mesh.geometry && rec.material === k.material && rec.attrs.aLegs[1] === 0 && rec.attrs.aHue[0] === c.hue && rec.color === null && Math.abs(rec.scale[1] / rec.scale[0] - STRETCH_Y) < 1e-6 && rec.stowable === true, 'take hands back the record', JSON.stringify({ size: rec.size, scale: rec.scale }))
  const { geometry: _g, material: _m, ...slot } = rec
  check(k.dress(slot).geometry === rec.geometry && k.dress(slot).material === rec.material, 'dress puts the packed record back on the mesh geometry and material')
  k.loaded = false
  check(k.dress(slot) === null, 'and is null before the asset lands')
  k.loaded = true
  let wrong = false
  try { k.dress({ ...slot, kind: 'spider' }) } catch { wrong = true }
  check(wrong, 'and throws for another kind')
  check(c.perch === null && !perch.crabs.includes(c) && alive(k).length === before - 1, 'and the crab is off its stone')
  // The same world again: every crab but that one.
  const again = new Crabs(scene, height, water, { seed, rocks, assets: asset })
  again.place(15, 0)
  const key = (of) => alive(of).map((g) => `${g.x.toFixed(3)},${g.z.toFixed(3)},${g.size.toFixed(3)}`).sort()
  check(JSON.stringify(key(again)) === JSON.stringify(key(k)) && alive(again).length === before - 1, 'the perch regrows without it, and nothing else moved', `${alive(again).length} of ${before}`)
  again.dispose()
  // Let go on the bank: it scuttles from her until it is RADIUS out.
  const ok = k.release(rec, 16, LEVEL + 0.4, 0, head)
  const loose = k.loose[0]
  check(ok && loose && loose.loose && loose.size === c.size && loose.state === 'go', 'release puts it down loose and going', loose ? loose.state : 'none')
  check(Math.abs(loose.y - groundAt(16, 0)) < 0.3, 'on the ground under the hand', `y ${loose.y.toFixed(2)} ground ${groundAt(16, 0).toFixed(2)}`)
  const d0 = Math.hypot(loose.x - head.x, loose.z - head.z)
  let yawTurns = 0
  let yaw = loose.yaw
  for (let i = 0; i < 5 * 72; i++) {
    k.update(head.x, head.y, head.z, DT, false)
    if (loose.yaw !== yaw) { yawTurns++; yaw = loose.yaw }
  }
  const d1 = Math.hypot(loose.x - head.x, loose.z - head.z)
  check(d1 > d0 + 2 && yawTurns >= 2, 'it scuttles away, jinking as it goes', `${(d1 - d0).toFixed(1)} m further off in 5 s, ${yawTurns} turns`)
  check(k.bodies([]).includes(loose), 'and the ear is offered it')
  let frames = 0
  while (k.loose.length > 0 && frames++ < 120 * 72) k.update(head.x, head.y, head.z, DT, false)
  check(k.loose.length === 0 && !loose.loose, `and it is forgotten past RADIUS ${RADIUS}`, `${(frames / 72).toFixed(1)} s`)
  k.dispose()
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
if (failures) process.exit(1)
