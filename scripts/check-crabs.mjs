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
// And, because the life is on the score (src/sim/score.js): two clients on
// different frame rates that draw the same second differently, one joining the
// shore mid-scuttle that crosses the rest of it differently, and a release
// that does not reach the room, or does not put the one crab on the one spot
// on the client it reaches (the only thing a crab sends).
//
// What this can NOT check: whether they look like crabs, or how the scuttle
// reads. That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import { Crabs, SHORE_M, PERCH_MIN, SIZE_M, DEEP_MUL, ROCK_FRACTION, PER_PERCH, SPEED, STRETCH_Y, SINK, WET_ROUGHNESS, HUE, RESEAT_EVERY, RADIUS, HUNT, GROW, PET } from '../src/v2/render/crabs.js'
import { MEAL } from '../src/v2/eating.js'
import { PERCH_STRIDE } from '../src/v2/render/rocks.js'
import { CARD_M, CRITTER_GLB, GLINT, hueTurnTint, setTierTint } from '../src/v2/render/critters.js'
import { taken } from '../src/v2/taken.js'
import { TEX_PX_MAX, TEX_PX_SMALL } from '../tools/creatures/creature-roster.mjs'
import { webpSize } from '../tools/tripo-pack.mjs'
import { LitterCards } from '../src/v2/render/litter-cards.js'
import { loadTiers } from '../tools/creatures/rig-crab.mjs'
import { BOUT_S, CRAB_ANIM_URL, FADE_S, parseCrabAnim, pickIdle, poseWeight, writeAnim } from '../src/v2/render/crab-anim.js'

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

// The room's clock in seconds, which a crab's every pose is a pure function of. The gate walks it by the frame; the frame's length itself never reaches a crab -- see the two rates at the end.
const DT = 1 / 72
let T = 0
const HEAD_Y = () => LEVEL + 1.6
// Frames from here until `pred` holds, up to `cap` seconds; used to reach a frame with a crab doing a particular thing rather than poking one into that state.
const windTo = (of, pred, cap = 200) => {
  let i = 0
  while (i++ < cap / DT && !pred()) of.update(15, HEAD_Y(), 0, (T += DT))
  return pred()
}

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
// The real baked clips on the slab: every vertex of the stand-in sits on the body bone.
const REAL_ANIM = parseCrabAnim(fs.readFileSync(new URL(`../public/${CRAB_ANIM_URL}`, import.meta.url)).buffer.slice(0))
const anim = { ...REAL_ANIM, tiers: [new Array(box.getAttribute('position').count).fill(0)] }

// --- construction and the shader hook -----------------------------------------
const scene = new THREE.Scene()
const crabs = new Crabs(scene, height, water, { seed: 11, rocks, cards: new LitterCards(4096), assets: asset, anim })
check(crabs.loaded && crabs.mesh.visible && Math.abs(crabs.span - 1) < 1e-6, 'asset set: visible, span 1', `span ${crabs.span}`)
{
  const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <lights_fragment_end>\n#include <dithering_fragment>\n' }
  crabs.material.onBeforeCompile(shader)
  // The tint row (critters.js tierTintSplice): the one mesh wears tier 0, painted over the encoded output after dithering. The far card is the shared pool's and wears no tint.
  check(shader.fragmentShader.includes('uniform vec4 uTierTint;') && /<dithering_fragment>\nif \( uTierTint\.w > 0\.5 \) gl_FragColor\.rgb = uTierTint\.xyz;/.test(shader.fragmentShader), 'the tint row paints over the output after dithering')
  setTierTint(true)
  const mt = shader.uniforms.uTierTint.value
  check(mt.w === 1, 'the row switches the mesh on')
  setTierTint(false)
  check(mt.w === 0, 'and off again')
  check(shader.vertexShader.includes('attribute float aBone;') && shader.vertexShader.includes('attribute vec4 aAnim;') && shader.vertexShader.includes('uniform highp sampler2D uCrabAnim;') && shader.uniforms.uCrabAnim.value === anim.texture, 'the animation texture sampler and bone attributes are spliced into the vertex shader')
  check(/<beginnormal_vertex>[\s\S]*objectNormal = vec3\( dot\( crabR0/.test(shader.vertexShader) && /<begin_vertex>[\s\S]*transformed = vec3\( dot\( crabR0/.test(shader.vertexShader), 'the bone matrix moves the normal and then the vertex')
  check(crabs.mesh.geometry.getAttribute('aAnim').isInstancedBufferAttribute && !crabs.mesh.geometry.getAttribute('aBone').isInstancedBufferAttribute && crabs.mesh.geometry.getAttribute('aBone').count === 24, 'aAnim is per instance and aBone per vertex')
  // The hue turn: read per instance on the mesh and applied to the sampled map before it is lit; the pool's card carries no aHue and takes it as an instanceColor tint.
  check(crabs.mesh.geometry.getAttribute('aHue') === crabs.hue && crabs.hue.isInstancedBufferAttribute && !crabs.litterCards.meshes.meshes[0].geometry.getAttribute('aHue'), 'hue rides in aHue on the mesh and not on the pool\'s card')
  check(shader.vertexShader.includes('attribute float aHue;') && shader.vertexShader.includes('vHue = aHue;') && /<map_fragment>\s*\{[^}]*cross\( hueK, diffuseColor\.rgb \)/.test(shader.fragmentShader), 'the hue turns the sampled colour after map_fragment')
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
  const k = new Crabs(scene, height, water, { seed, rocks, cards: new LitterCards(4096), assets: asset, anim })
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
  for (let i = 0; i < 2; i++) crabs.update(200, LEVEL + 1.6, 200, (T += DT))
  const versions = () => [crabs.mesh.instanceMatrix.version, crabs.animAttr.version, crabs.hue.version, crabs.litterCards.meshes.meshes[0].instanceMatrix.version, crabs.litterCards.meshes.meshes[0].instanceColor.version].join(',')
  const v0 = versions()
  for (let i = 0; i < 72; i++) crabs.update(200, LEVEL + 1.6, 200, (T += DT))
  check(versions() === v0 && crabs.mesh.count === 0, 'and a second of frames there re-uploads no buffer', `versions ${v0}`)
}
crabs.place(15, 0)
const snapB = alive().map((c) => [c.x, c.z, c.size]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
check(JSON.stringify(snapA) === JSON.stringify(snapB), 'placement is a pure function of the rocks', `${snapA.length} crabs`)

// --- the run -------------------------------------------------------------------
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
  crabs.update(15, LEVEL + 1.6, 0, (T += DT))
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
check(crabs.mesh.count === alive().length && crabs.cardCount === 0, 'the instance count is the live count, and before the bake all of it is the mesh', `${crabs.mesh.count}`)

// --- the stone moving under a seated crab ----------------------------------------
// A rock re-seated on a re-split chunk drops or rises by more than the drawn top a crab's spell was planned against; a crab follows within RESEAT_EVERY frames either way, sitting or scuttling.
{
  const seated = () => alive().filter((c) => Math.abs(c.y - stoneUnder(c)) < 1e-6).length
  const n = alive().length
  // A frame with one of each, so the re-seat is asked of a crab mid-scuttle and of one sitting still.
  const both = () => alive().some((c) => c.state === 'go') && alive().some((c) => c.state === 'pause')
  check(windTo(crabs, both), 'some frame has a crab crossing its rock and another sitting on theirs')
  for (const shift of [-0.45, 0.45]) {
    lift += shift
    check(seated() < n * 0.5, `the stone ${shift < 0 ? 'drops' : 'rises'} ${Math.abs(shift)} m and the crabs are left ${shift < 0 ? 'in the air' : 'in the stone'}`, `${seated()} of ${n} seated`)
    const going = alive().filter((c) => c.state === 'go').length
    for (let i = 0; i < RESEAT_EVERY; i++) crabs.update(15, LEVEL + 1.6, 0, (T += DT))
    check(seated() === n, `every crab is back on the stone within ${RESEAT_EVERY} frames, the ${going} scuttling and the ${n - going} sitting alike`, `${seated()} of ${n}`)
  }
  check(lift === 0 && seated() === n, 'and on it again once the stone is back')
}

// --- the ear hears the crabs -----------------------------------------------------
// bodies() is what the ambience reads for the crawl loop: the slots themselves, `speed > 0` on the ones on the move, a pause at speed 0.
{
  windTo(crabs, () => alive().some((c) => c.state === 'go') && alive().some((c) => c.state === 'pause'))
  const walker = alive().find((c) => c.state === 'go')
  const pauser = alive().find((c) => c.state === 'pause')
  const listed = crabs.bodies([])
  check(listed.length === alive().length && listed.includes(walker) && walker.speed > 0, 'every seated crab is listed, the walker at its pace', `${listed.length} of ${alive().length}`)
  check(listed.includes(pauser) && pauser.speed === 0, 'the pauser listed at speed 0')
  windTo(crabs, () => walker.state !== 'go')
  check(walker.state === 'pause' && walker.speed === 0 && crabs.bodies([]).includes(walker), 'its scuttle over, the walker sits down at speed 0 and stays listed')
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

// --- the top card: far crabs leave the mesh for the card, under the same matrix ----
{
  const lc = crabs.litterCards
  const pic = crabs.cardPicture
  const { halfX, halfZ } = crabs.bounds
  check(pic >= 0 && lc.mode[pic].x === 2 && lc.box[pic].z > halfX && lc.box[pic].w > halfZ && crabs.cards.layer.every((v) => v === pic) && lc.claimed === 24, 'every slot\'s card instance wears the one top picture, sized to the body\'s length by its breadth, and the pool was told the crowd it needs', `kind ${lc.mode[pic].x}, claimed ${lc.claimed}`)
  check(crabs.cardCount === 0 && !crabs.cardReady, 'no card is drawn until its picture is baked')
  // Pooled over seeds again, so both sides of the line are populated: the shelf is a few metres from her, the floor and the beach well past CARD_M.
  const HEAD = [15, LEVEL + 1.6, 0]
  const dist = (e, i) => Math.hypot(e[i * 16 + 12] - HEAD[0], e[i * 16 + 13] - HEAD[1], e[i * 16 + 14] - HEAD[2])
  let meshN = 0, cardN = 0, liveN = 0, matched = 0
  const tintNear = (p, q) => Math.abs(p.r - q.r) < 1e-6 && Math.abs(p.g - q.g) < 1e-6 && Math.abs(p.b - q.b) < 1e-6
  const near = [], far = []
  for (let seed = 1; seed <= SEEDS; seed++) {
    const k = new Crabs(scene, height, water, { seed, rocks, cards: new LitterCards(4096), assets: asset, anim })
    // A sandy picture of opaque texels, standing in for the bake.
    const px = k.litterCards.pixels(k.cardPicture)
    for (let i = 0; i < px.length; i += 4) px.set([200, 150, 90, 255], i)
    k.setCard()
    k.place(15, 0)
    k.update(...HEAD, T)
    const e = k.mesh.instanceMatrix.array
    for (let i = 0; i < k.mesh.count; i++) near.push(dist(e, i))
    for (const c of alive(k)) {
      if (!k.cards.vis[c.id]) continue
      const ce = k.cards.mat
      far.push(Math.hypot(c.x - HEAD[0], c.y - HEAD[1], c.z - HEAD[2]))
      // The card is the body's matrix, lifted to the body's middle and laid flat: its up is the body's -Z, its right the body's X, centred on the crab's own normal.
      const m = k.cards.getMatrixAt(c.id, new THREE.Matrix4())
      const body = new THREE.Matrix4().fromArray(c.m)
      const mid = new THREE.Vector3(0, k.cardLift, 0).applyMatrix4(body)
      const e0 = m.elements, b0 = body.elements
      const up = new THREE.Vector3(e0[4], e0[5], e0[6]).normalize()
      const bz = new THREE.Vector3(-b0[8], -b0[9], -b0[10]).normalize()
      const right = new THREE.Vector3(e0[0], e0[1], e0[2]).normalize()
      const bx = new THREE.Vector3(b0[0], b0[1], b0[2]).normalize()
      if (up.distanceTo(bz) < 1e-5 && right.distanceTo(bx) < 1e-5 && Math.abs(e0[12] - mid.x) < 1e-5 && Math.abs(e0[13] - mid.y) < 1e-5 && Math.abs(e0[14] - mid.z) < 1e-5 && tintNear(k.cards.getColorAt(c.id, new THREE.Color()), hueTurnTint(k.cardMean, c.hue, new THREE.Color()))) matched++
    }
    meshN += k.mesh.count; cardN += k.cardCount; liveN += alive(k).length
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
for (let i = 0; i < 400; i++) crabs.update(15, LEVEL + 1.6, 0, (T += DT))
check(alive().length === snapA.length, 'a tile whose rocks landed after the scan gets its crabs on the rescan', `${alive().length} of ${snapA.length}`)

// --- from above the surface, a sunk crab is neither drawn nor stepped ----------
{
  // The first seed that puts a crab on the floor stone AND one on the beach.
  let k = null
  for (let seed = 1; seed <= 16 && !k; seed++) {
    const t = new Crabs(scene, height, water, { seed, rocks, cards: new LitterCards(4096), assets: asset, anim })
    t.place(15, 0)
    if (alive(t).some((c) => c.y < c.perch.level) && alive(t).some((c) => !(c.y < c.perch.level))) k = t
    else t.dispose()
  }
  check(k !== null, 'some seed seats crabs both under the lake and on its beach')
  const written = () => k.mesh.count + k.cardCount
  const sunk = alive(k).filter((c) => c.y < c.perch.level)
  const dry = alive(k).filter((c) => !(c.y < c.perch.level))
  check(sunk.every((c) => c.y < LEVEL) && dry.every((c) => c.y >= LEVEL), 'every crab knows its lake level, and whether it is under it', `${sunk.length} sunk, ${dry.length} dry`)
  const pose = sunk.map((c) => [c, c.x, c.y, c.z, c.elapsed, c.phase])
  for (let i = 0; i < 5 * 72; i++) k.update(15, LEVEL + 1.6, 0, (T += DT), false)
  check(written() === dry.length, 'with her head in the air only the dry crabs are written', `${written()} of ${alive(k).length}`)
  check(pose.every(([c, x, y, z, elapsed, phase]) => c.x === x && c.y === y && c.z === z && c.elapsed === elapsed && c.phase === phase), 'and no sunk crab moves or counts the time')
  check(k.bodies([]).length === dry.length && !k.bodies([]).some((c) => sunk.includes(c)), 'and the ear is offered the dry crabs alone', `${k.bodies([]).length} listed`)
  for (let i = 0; i < 5 * 72; i++) k.update(15, LEVEL - 1, 0, (T += DT), true)
  check(written() === alive(k).length, 'under, every crab is written again', `${written()} of ${alive(k).length}`)
  check(pose.some(([c, x, y, z, elapsed]) => c.elapsed !== elapsed), 'and the sunk ones pick their spell back up when she goes under')
  check(k.bodies([]).length === alive(k).length, 'and the ear is offered all of them')
  k.dispose()
}

// --- two clients see the one shore ----------------------------------------------
// Before the hands below: `taken` is a module-global, and a crab caught there would be missing from every shore rolled after.
{
  const pose = (of) => alive(of).map((c) => `${c.key}|${c.x.toFixed(9)},${c.y.toFixed(9)},${c.z.toFixed(9)}|${c.yaw.toFixed(9)}|${c.state}`).sort().join('\n')
  const make = () => new Crabs(scene, height, water, { seed: 4, rocks, cards: new LitterCards(4096), assets: asset, anim })
  const slow = make(); slow.place(15, 0, 4000)
  const fast = make(); fast.place(15, 0, 4000)
  // One at 24 fps from the shore's first second; one at 144 with a stutter every seventh frame, joining at the same second.
  let a = 4000
  slow.update(15, HEAD_Y(), 0, a)
  for (let k = 0; k < 24 * 90; k++) { a += 1 / 24; slow.update(15, HEAD_Y(), 0, a) }
  slow.update(15, HEAD_Y(), 0, 4090)
  let b = 4000
  fast.update(15, HEAD_Y(), 0, b)
  for (let k = 0; k < 900; k++) { b += k % 7 === 0 ? 0.4 : 1 / 144; fast.update(15, HEAD_Y(), 0, b) }
  fast.update(15, HEAD_Y(), 0, 4090)
  check(pose(slow) === pose(fast) && alive(slow).length > 0, 'two clients on different frame rates draw the same shore at the same world second', `${alive(slow).length} crabs`)
  const joined = make()
  joined.place(15, 0, 4090)
  joined.update(15, HEAD_Y(), 0, 4090)
  check(pose(joined) === pose(slow), 'and so does one meeting the shore at that second, from its first frame')
  // One that walks up mid-scuttle, a spell's width later, still agrees.
  const late = make()
  late.place(15, 0, 4103.5)
  late.update(15, HEAD_Y(), 0, 4103.5)
  slow.update(15, HEAD_Y(), 0, 4103.5)
  check(pose(late) === pose(slow), 'and one arriving in the middle of a scuttle crosses the rest of it the same')
  check(alive(slow).some((c) => c.state === 'go'), 'and a crab was mid-scuttle at that second', `${alive(slow).filter((c) => c.state === 'go').length} of ${alive(slow).length}`)
  check(slow.pending().length === 0 && typeof slow.applyLured !== 'function', 'and a crab on its plan owes the room nothing: no anchor, no lured set')

  // The one thing a crab does send: the release, without which a peer watches it go into a hand and never land.
  const loosePose = (of) => of.loose.map((c) => `${c.key}|${c.x.toFixed(9)},${c.y.toFixed(9)},${c.z.toFixed(9)}|${c.yaw.toFixed(9)}|${c.state}|${c.size.toFixed(9)},${c.hue.toFixed(9)}`).sort().join('\n')
  const rec = { kind: 'crab', size: 0.337, attrs: { aHue: [0.21] } }
  check(slow.release(rec, 15.0004, LEVEL, 0.0004, { x: 13.0004, y: HEAD_Y(), z: 0 }, 4103.5), 'a crab let go here is let go')
  const owed = slow.pending()
  check(owed.length === 1 && slow.pending().length === 0, 'and is owed to the room once', `${owed.length} anchor`)
  const drop = owed[0]
  check(drop[0].startsWith('cb:') && /^[a-z0-9:,-]{1,32}$/.test(drop[0]) && drop[7] === 'drop' && drop[8] === null && Number.isInteger(drop[6]), 'as one anchor in mode drop under the crabs\' prefix', drop[0])
  check(JSON.stringify(drop).length <= 256, 'inside the relay\'s 256 bytes', `${JSON.stringify(drop).length} bytes`)
  drop[8] = 'peer'
  late.apply(drop, 4103.5)
  check(late.loose.length === 1 && late.pending().length === 0, 'the peer told of it lets the same crab go, and owes it nobody')
  check(loosePose(late) === loosePose(slow), 'at the same spot, the same size and hue, on the same key', slow.loose[0].key)
  late.apply(drop, 4103.5)
  check(late.loose.length === 1, 'and a second telling -- a fresh welcome -- lets no second crab go')
  slow.apply(drop, 4103.5)
  check(slow.loose.length === 1, 'nor does her own drop come back to her')
  for (let k = 0; k < 24 * 20; k++) { const t = 4103.5 + k / 24; slow.update(15, HEAD_Y(), 0, t); late.update(15, HEAD_Y(), 0, t) }
  check(loosePose(late) === loosePose(slow) && slow.loose[0].x !== 15.0004, 'and twenty seconds on they are watching the one crab run the one way', `${(slow.loose[0].x - 15.0004).toFixed(2)} m off`)
  slow.dispose(); fast.dispose(); joined.dispose(); late.dispose()
}

// --- her hand: a crab taken, the perch never regrowing it, one let go of scuttling off --
{
  live = BOULDERS
  // The first seed with a crab on the beach.
  let k = null
  let seed = 0
  while (!k && ++seed <= 16) {
    const t = new Crabs(scene, height, water, { seed, rocks, cards: new LitterCards(4096), assets: asset, anim })
    t.place(15, 0)
    if (alive(t).some((c) => c.y >= LEVEL)) k = t
    else t.dispose()
  }
  check(k !== null, 'some seed seats a crab on the beach', `seed ${seed}`)
  const head = { x: 15, y: LEVEL + 1.6, z: 0, yaw: 0 }
  k.update(head.x, head.y, head.z, (T += DT), false)
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
  check(rec.kind === 'crab' && rec.size === c.size && rec.geometry === k.mesh.geometry && rec.material === k.material && rec.attrs.aAnim.length === 4 && rec.attrs.aHue[0] === c.hue && rec.color === null && Math.abs(rec.scale[1] / rec.scale[0] - STRETCH_Y) < 1e-6 && rec.stowable === true, 'take hands back the record', JSON.stringify({ size: rec.size, scale: rec.scale }))
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
  const again = new Crabs(scene, height, water, { seed, rocks, cards: new LitterCards(4096), assets: asset, anim })
  again.place(15, 0)
  const key = (of) => alive(of).map((g) => `${g.x.toFixed(3)},${g.z.toFixed(3)},${g.size.toFixed(3)}`).sort()
  check(JSON.stringify(key(again)) === JSON.stringify(key(k)) && alive(again).length === before - 1, 'the perch regrows without it, and nothing else moved', `${alive(again).length} of ${before}`)
  {
    // A peer's take: evicted by perch and member within the registry's tolerance; another member's key, a foreign key, an empty spot and a perch once emptied are false.
    const e = alive(again)[0]
    const ep = e.perch
    const n0 = alive(again).length
    check(again.evict(`crab${e.member + 100}`, ep.x, ep.z) === false && again.evict('spider:rock0', ep.x, ep.z) === false && again.evict(`crab${e.member}`, ep.x + 5, ep.z) === false && alive(again).length === n0, 'evict is false for another member, a foreign key or an empty spot')
    check(again.evict(`crab${e.member}`, ep.x + 0.03, ep.z - 0.03) === true && e.perch === null && !ep.crabs.includes(e) && alive(again).length === n0 - 1 && taken.has(`crab${e.member}`, ep.x, ep.z), 'evict takes the crab a peer took off its stone and records the place')
    check(again.evict(`crab${e.member}`, ep.x, ep.z) === false, 'and is false for the perch once emptied')
  }
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
    k.update(head.x, head.y, head.z, (T += DT), false)
    if (loose.yaw !== yaw) { yawTurns++; yaw = loose.yaw }
  }
  const d1 = Math.hypot(loose.x - head.x, loose.z - head.z)
  check(d1 > d0 + 2 && yawTurns >= 2, 'it scuttles away, jinking as it goes', `${(d1 - d0).toFixed(1)} m further off in 5 s, ${yawTurns} turns`)
  check(k.bodies([]).includes(loose), 'and the ear is offered it')
  let frames = 0
  while (k.loose.length > 0 && frames++ < 120 * 72) k.update(head.x, head.y, head.z, (T += DT), false)
  check(k.loose.length === 0 && !loose.loose, `and it is forgotten past RADIUS ${RADIUS}`, `${(frames / 72).toFixed(1)} s`)
  k.dispose()
}

// --- at an eighth of her size a crab near her comes for her and bites; grown, it goes home ---
{
  const hits = []
  const k = new Crabs(scene, height, water, { seed: 11, rocks, cards: new LitterCards(4096), assets: asset, anim, harm: (n) => hits.push(n) })
  k.update(15, HEAD_Y(), 0, (T += DT))
  const c = alive(k)[0]
  const her = { x: c.x + 2, y: c.y + 0.2, z: c.z }
  const run = (s) => { for (let i = 0; i < s / DT; i++) k.update(her.x, her.y, her.z, (T += DT)) }
  const off = () => Math.hypot(c.x - her.x, c.z - her.z)
  run(2)
  check(c.hunt === null && hits.length === 0, 'her at full size 2 m off, it keeps to its spell')
  k.sized(0.125)
  run(5)
  check(c.hunt !== null && !c.hunt.back && off() <= c.size + 0.01 && hits.length >= 3 && hits.every((n) => n === HUNT.harm), `at an eighth of her size it scuttles to her and bites, ${HUNT.harm} a bite`, `${off().toFixed(2)} m off, bites ${hits.join(' ')}`)
  k.sized(1)
  run(10)
  const home = { x: c.x, z: c.z }
  k._play(c, T)
  check(c.hunt === null && Math.hypot(c.x - home.x, c.z - home.z) < 1e-6, 'grown, it walks back onto its spell', `${c.hunt && 'still out'}`)
  k.dispose()
}

// --- her bug held at a crab: eaten, the crab grown and at her heels, and a peer's client told ---
{
  const eaten = []
  const make = (eat) => new Crabs(scene, height, water, { seed: 11, rocks, cards: new LitterCards(4096), assets: asset, anim, eat })
  const k = make((l) => { eaten.push(l); return true })
  const peer = make(() => true)
  const head = { x: 15, y: HEAD_Y(), z: 0 }
  k.update(head.x, head.y, head.z, (T += DT))
  peer.update(head.x, head.y, head.z, T)
  const c = alive(k).find((g) => g.y >= LEVEL) ?? alive(k)[0]
  const size0 = c.size
  const perch = c.perch
  const member = c.member
  const fly = { kind: 'butterfly', x: c.x + 3, y: c.y + 0.2, z: c.z, by: null }
  k.update(head.x, head.y, head.z, (T += DT), true, [fly])
  check(eaten.length === 0 && k.pets.length === 0, 'a bug held 3 m off is not eaten')
  const spider = { kind: 'spider', x: c.x, y: c.y + 0.2, z: c.z, by: null }
  k.update(head.x, head.y, head.z, (T += DT), true, [spider])
  check(eaten.length === 1 && eaten[0] === spider, 'a spider held at a crab is eaten')
  check(k.pets.length === 1 && k.pets[0] === c && c.pet.by === null && Math.abs(c.size - size0 * GROW) < 1e-9, `and the crab grows ${GROW}x and is her pet`, `${size0.toFixed(3)} -> ${c.size.toFixed(3)}`)
  check(c.perch === null && taken.has(`crab${member}`, perch.x, perch.z), 'off its stone, the place in the taken registry')
  const owed = k.pending()
  const fed = owed[0]
  check(owed.length === 1 && fed[7] === 'fed' && fed.length === 14 && fed[8] === null && /^[a-z0-9:,-]{1,32}$/.test(fed[0]) && JSON.stringify(fed).length <= 256, 'and the room is owed one 14-field fed anchor', JSON.stringify(fed))
  const second = { ...spider, x: c.x, z: c.z }
  k.update(head.x, head.y, head.z, (T += DT), true, [second])
  check(eaten.length === 2 && eaten[1] === second && k.pets.length === 1 && Math.abs(c.size - size0 * GROW * (1 + MEAL.grow)) < 1e-9, `her pet eats a second spider and grows ${MEAL.grow * 100}%`, `${c.size.toFixed(3)}`)
  const refed = k.pending()
  check(refed.length === 1 && refed[0][7] === 'fed' && refed[0][0] === fed[0] && Math.abs(refed[0][9] - c.size) < 1e-3, 'and the room hears it on the same wire, grown', JSON.stringify(refed[0]))
  const walk = (of, to, s) => { for (let i = 0; i < s / DT; i++) of.update(to.x, to.y, to.z, (T += DT), true, [], [{ by: 7, x: to.x, y: to.y, z: to.z }]) }
  const there = { x: c.x + 6, y: head.y, z: c.z + 2 }
  walk(k, there, 6)
  const off = Math.hypot(c.x - there.x, c.z - there.z)
  check(off < PET.m + 0.3 && off > PET.m - 0.3, `it scuttles after her and stops about ${PET.m} m off`, `${off.toFixed(2)} m`)
  fed[8] = 7
  peer.apply(fed, T)
  const theirs = peer.pets[0]
  refed[0][8] = 7
  peer.apply(refed[0], T)
  check(peer.pets.length === 1 && theirs.pet.by === 7 && Math.abs(theirs.size - c.size) < 1e-3 && peer.pending().length === 0, 'the peer told of both meals has one pet, grown, by the feeder, and owes nobody')
  walk(peer, there, 6)
  const peerOff = Math.hypot(theirs.x - there.x, theirs.z - there.z)
  check(peerOff < PET.m + 0.3, 'and it follows the feeder there', `${peerOff.toFixed(2)} m`)
  const steal = refed[0].slice()
  steal[9] = refed[0][9] * (1 + MEAL.grow)
  k.apply(steal, T)
  check(k.pets.length === 1 && c.pet.by === 7 && c.size === steal[9], 'a peer feeding her pet makes it theirs, grown the same on her client', `by ${c.pet.by}, ${c.size.toFixed(3)}`)
  const rec = k.take({ dist: 0, c, size: c.size }, Infinity)
  const took = k.pending()
  check(rec.kind === 'crab' && k.pets.length === 0 && took.length === 1 && took[0][7] === 'took' && took[0][0] === fed[0], 'taken in hand it is no pet, and the room is told on the same wire')
  took[0][8] = 7
  peer.apply(took[0], T)
  check(peer.pets.length === 0, 'and the peer lets it go too')
  k.dispose(); peer.dispose()
}

// --- the rig and its clips -----------------------------------------------------
// The bake (tools/creatures/ship-crab.mjs) is a file; these are the ways it can be wrong without anything throwing.
{
  const { rig, tiers } = loadTiers()
  const glbVerts = [909, 534, 281, 113]
  check(REAL_ANIM.tiers.length === 4 && REAL_ANIM.tiers.every((t, i) => t.length === tiers[i].V.length && t.length === glbVerts[i]), 'the bake binds every LOD tier, one bone a vertex, at the shipped vertex counts', REAL_ANIM.tiers.map((t) => t.length).join('/'))
  check(REAL_ANIM.tiers.every((t, i) => t.every((b, v) => b === tiers[i].bone[v])), 'and binds them as the rig finds them now (a stale bake fails here)')
  check(REAL_ANIM.tiers.every((t) => t.every((b) => Number.isInteger(b) && b >= 0 && b < REAL_ANIM.bones)), 'every vertex names a bone the texture has', `${REAL_ANIM.bones} bones`)
  const names = rig.bones.map((b) => b.name)
  check(names.length === REAL_ANIM.bones, 'the rig and the texture agree on the bone count', `${names.length}`)
  const count = (tier, name) => REAL_ANIM.tiers[tier].filter((b) => b === names.indexOf(name)).length
  const legs = names.filter((n) => /leg/i.test(n))
  const claws = names.filter((n) => /claw|pincer|finger/i.test(n))
  check(legs.length >= 14 && claws.length >= 4, 'seven walking legs of at least two segments and two claws with a finger', `${legs.length} leg bones, ${claws.length} claw bones`)
  check([...legs, ...claws].every((n) => count(0, n) >= 8), 'every leg and claw bone owns a plausible share of the body', [...legs, ...claws].map((n) => `${n}:${count(0, n)}`).join(' '))
  check(count(0, names[0]) > 100 && count(0, names[0]) < REAL_ANIM.tiers[0].length * 0.7, 'the body bone owns the shell but not the whole mesh', `${count(0, names[0])} of ${REAL_ANIM.tiers[0].length}`)
  for (let t = 1; t < 4; t++) console.log(`  info  LOD${t} bones without verts: ${[...legs, ...claws].filter((n) => count(t, n) === 0).join(', ') || 'none'}`)
  check([...legs, ...claws].every((n) => count(1, n) > 0), 'LOD1 still has verts on every leg and claw bone')

  // Half floats back to numbers.
  const half = (h) => { const e = (h >> 10) & 31, m = h & 1023, sg = h & 0x8000 ? -1 : 1; return e === 0 ? sg * m * 2 ** -24 : sg * (1 + m / 1024) * 2 ** (e - 15) }
  const rowAt = (r) => Array.from(REAL_ANIM.data.subarray(r * REAL_ANIM.bones * 12, (r + 1) * REAL_ANIM.bones * 12), half)
  const stepOf = (a, b) => { const x = rowAt(a), y = rowAt(b); let d = 0; for (let i = 0; i < x.length; i++) d = Math.max(d, Math.abs(x[i] - y[i])); return d }
  const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]
  for (const c of [REAL_ANIM.walk, ...REAL_ANIM.idles]) {
    const steps = Array.from({ length: c.frames - 1 }, (_, f) => stepOf(c.base + f, c.base + f + 1))
    const wrap = stepOf(c.base + c.frames - 1, c.base)
    const typical = Math.max(...steps)
    check(wrap <= typical * 1.5 + 1e-3, `${c.name} loops: its last frame steps to its first no harder than the clip steps within itself`, `wrap ${wrap.toFixed(4)}, largest inner ${typical.toFixed(4)}`)
    const f0 = rowAt(c.base)
    if (c.kind === 'idle') check(f0.every((v, i) => Math.abs(v - IDENT[i % 12]) < 2e-3), `${c.name} starts on the bind pose`)
    check(c.name === 'walk' || BOUT_S % c.seconds === 0, `${c.name} divides a ${BOUT_S} s bout`, `${c.seconds} s`)
  }
  check(REAL_ANIM.idles.length >= 4 && new Set(REAL_ANIM.idles.map((c) => c.name)).size === REAL_ANIM.idles.length, 'four or more distinct idles', REAL_ANIM.idles.map((c) => c.name).join(', '))
  check(REAL_ANIM.walk.cycle > 0 && Number.isFinite(REAL_ANIM.walk.cycle), 'the walk says how far a cycle carries the body', `${REAL_ANIM.walk.cycle.toFixed(3)} mesh units`)

  // Which clip, and when, is a function of the key and the clock alone.
  const sample = (key, salt) => Array.from({ length: 24 }, (_, b) => pickIdle(REAL_ANIM, key, salt, b).name)
  check(JSON.stringify(sample(123456, 3)) === JSON.stringify(sample(123456, 3)), 'pickIdle is a pure function of key, standstill and bout')
  const spread = new Set()
  for (let key = 1; key <= 200; key++) for (const n of sample(key * 7919, 1)) spread.add(n)
  check(spread.size === REAL_ANIM.idles.length, 'every idle is chosen by some crab, bout or standstill', [...spread].join(', '))
  check(new Set(Array.from({ length: 40 }, (_, k) => pickIdle(REAL_ANIM, k * 104729 + 5, 0, 0).name)).size > 1, 'different crabs roll different idles')
  const out = (c) => { const o = new Float32Array(4); writeAnim(REAL_ANIM, c, o, 0); return Array.from(o) }
  const still = (t) => ({ state: 'pause', key: 777, phase0: 0.3, side: 1, phase: 0, still: t, stillSalt: 2, w: 1 })
  const bout = still(5 * BOUT_S + 2.5)
  check(JSON.stringify(out(bout)) === JSON.stringify(out({ ...bout })) && out(still(2)).length === 4, 'writeAnim of a standstill is a pure function of the crab\'s fields')
  const lo = Math.min(...REAL_ANIM.idles.map((c) => c.base)), hi = Math.max(...REAL_ANIM.idles.map((c) => c.base + c.frames))
  check([0, 3, 17, 40, 99].every((t) => { const [a, b] = out(still(t)); return a >= lo && a < hi && b >= lo && b < hi }), 'a resting crab reads idle rows')
  const go = (ph) => ({ state: 'go', key: 777, phase0: 0.3, side: 1, phase: ph, still: 0, stillSalt: 0, w: 1 })
  check([0, 0.37, 5.9, 120.2].every((ph) => { const [a, b] = out(go(ph)); return a >= 0 && a < REAL_ANIM.walk.frames && b >= 0 && b < REAL_ANIM.walk.frames }), 'a moving crab reads walk rows')
  const fwd = out(go(0.1)), back = out({ ...go(0.1), side: -1 })
  check(fwd[0] !== back[0] || fwd[2] !== back[2], 'the end that leads reverses the walk')
  const c1 = out(go(0.123)), c2 = out(go(1.123))
  check(c1[0] === c2[0] && c1[1] === c2[1] && Math.abs(c1[2] - c2[2]) < 1e-3, 'one walk cycle later is the same pose')
  check(poseWeight(0, 10) === 0 && poseWeight(5, 10) === 1 && poseWeight(10, 10) === 0 && poseWeight(FADE_S / 2, 10) > 0 && poseWeight(FADE_S / 2, 10) < 1 && poseWeight(0, 0) === 0, 'the pose fades in and out over FADE_S at the ends of a phrase')
}

// A crab's anim as drawn is the same at any frame rate, and the same for a client that joins late.
{
  const mk = () => new Crabs(scene, height, water, { seed: 11, rocks, cards: new LitterCards(4096), assets: asset, anim })
  const a = mk(), b = mk()
  a.place(15, 0); b.place(15, 0)
  const read = (k) => alive(k).map((c) => { const o = new Float32Array(4); writeAnim(anim, c, o, 0); return `${c.state}:${Array.from(o).map((v) => v.toFixed(3))}` })
  let t0 = T
  let sawGo = 0, sawPause = 0, agree = true
  for (let s = 0; s < 60; s++) {
    const now = t0 + s * 7.3
    for (const c of alive(a)) a._play(c, now)
    // B jumps straight there, as a client that has only just walked in.
    for (const c of alive(b)) b._play(c, now)
    const ra = read(a), rb = read(b)
    if (JSON.stringify(ra) !== JSON.stringify(rb)) agree = false
    for (const c of alive(a)) { if (c.state === 'go') sawGo++; else sawPause++ }
  }
  check(agree, 'two clients holding the same room clock draw every crab\'s clip frame identically')
  check(sawGo > 0 && sawPause > 0, 'the shore holds crabs that walk and crabs that rest', `${sawGo} walking samples, ${sawPause} resting`)
  check(alive(a).filter((c) => c.state === 'go').every((c) => { const o = new Float32Array(4); writeAnim(anim, c, o, 0); return o[0] < anim.walk.frames }) && alive(a).filter((c) => c.state === 'pause').every((c) => { const o = new Float32Array(4); writeAnim(anim, c, o, 0); return o[0] >= anim.walk.frames }), 'at the last sample the walkers read walk rows and the resters idle rows')
  a.dispose(); b.dispose()
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
if (failures) process.exit(1)
