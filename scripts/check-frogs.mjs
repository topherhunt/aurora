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
// that hops off the band or into the river, that never hops, that drifts away
// from where it was placed; a frog that only ever leaps, a walk whose hops are
// leap-sized or wander off its line, or that has no beat between its hops; a
// scatter that is not the same twice; a frame that
// costs more than a scatter is allowed to; a far frog still drawn as the mesh,
// or a card that is not its frog's own matrix, tint and hue, or that is not dithered.
// The shipped GLB is checked for existence and shape too, because the world
// loads it by name.
//
// What this can NOT check: whether they look like frogs, or how the hop reads.
// That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import { Frogs, DENSITY, TILE, SHORE_M, SIZE_M, MAX, TETHER_M, BREATH_S, BREATH_AMP, WALK, LEAP, WET_ROUGHNESS, HUE } from '../src/v2/render/frogs.js'
import { CARD_M, CRITTER_GLB, GLINT } from '../src/v2/render/critters.js'
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
  levelAt: (x) => (Math.abs(x) < HALF ? GROUND + 0.5 : null),
  isSubmerged(x, z, g) { const l = this.levelAt(x, z); return l !== null && g < l },
  shoreDistAt(x, z, reach) {
    if (!(reach > 0)) throw new Error('reach')
    const d = Math.abs(x) - HALF
    return d > reach ? reach : d < -reach ? -reach : d
  },
}
const rocks = { blockTopAt: (x, z) => (inRock(x, z) ? ROCK.top : -Infinity) }
// A drawn surface a hand above the field, to see the frogs seat on it rather than the field.
const ground = { groundAt: () => GROUND + 0.05 }

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
  }
}

// --- a stand-in asset: a unit box, feet at y = 0 -----------------------------
const box = new THREE.BoxGeometry(1, 0.5, 0.7).translate(0, 0.25, 0)
const asset = {
  pos: box.getAttribute('position').array,
  nrm: box.getAttribute('normal').array,
  uv: box.getAttribute('uv').array,
  idx: Array.from(box.index.array),
  map: null,
}

// --- construction and the shader hook -----------------------------------------
const scene = new THREE.Scene()
const frogs = new Frogs(scene, height, water, { seed: 7, rocks, ground, assets: asset })
check(frogs.loaded && frogs.mesh.visible && Math.abs(frogs.span - 1) < 1e-6, 'asset set: visible, span 1', `span ${frogs.span}`)
check(frogs.mesh.instanceColor && frogs.mesh.instanceColor.isInstancedBufferAttribute, 'tint rides in instanceColor')
check(frogs.mesh.geometry.getAttribute('aHue') === frogs.hue && frogs.hue.isInstancedBufferAttribute && frogs.card.geometry.getAttribute('aHue') === frogs.cardHue, 'hue rides in aHue on the mesh and the card')
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
  check(new Set(hues.map((h) => h.toFixed(3))).size > all.length * 0.8 && Math.min(...hues) < -HUE * 0.5 && Math.max(...hues) > HUE * 0.5 && hues.every((h) => Math.abs(h) <= HUE), 'hues vary either way round the wheel, within HUE', `${Math.min(...hues).toFixed(2)}..${Math.max(...hues).toFixed(2)} rad`)
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

// --- the run ---------------------------------------------------------------------
const DT = 1 / 72
const SECONDS = 60
const homes = new Map(alive().map((f) => [f, { x: f.homeX, z: f.homeZ }]))
let hopped = 0
let wet = 0
let offBand = 0
let onRock = 0
let strayed = 0
let maxStray = 0
// The gait, read off each frog's transitions: a bout starts with a hop from a spent `hops` count.
const bouts = { walk: 0, leap: 0 }
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
      if (p.hops === 0) bouts[f.bout === WALK ? 'walk' : 'leap']++
      else if (f.bout === WALK) { walkPairs++; if (turn(f.yaw - p.yaw) < 0.6 + 1e-9) straight++ }
    }
    if (p && f.state === 'sit' && p.state === 'hop' && f.hops > 0 && (f.left < f.bout.pause[0] - 1e-9 || f.left > f.bout.pause[1] + 1e-9)) badPause++
    last.set(f, { state: f.state, yaw: f.yaw, hops: f.hops })
    if (f.state === 'hop') hopped++
    if (Math.abs(f.x) < HALF) wet++
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
check(bouts.walk > bouts.leap && bouts.leap > 0, 'most bouts are walks, the rest leaps', `${bouts.walk} walks, ${bouts.leap} leaps`)
check(badReach === 0, `a walk's hops are ${WALK.m[0]}-${WALK.m[1]} body lengths and a leap's ${LEAP.m[0]}-${LEAP.m[1]}`, `${badReach} off`)
check(walkPairs > 0 && straight / walkPairs > 0.7, 'a walk\'s hops follow one another along its line', `${straight} of ${walkPairs} pairs within the wobble`)
check(badPause === 0, 'the beat between a bout\'s hops is the bout\'s own', `${badPause} off`)
check(wet === 0, 'no frog ever lands in the river', `${wet} wet frames`)
check(offBand === 0, 'no frog hops off the shore band', `${offBand} frames`)
check(onRock === 0, 'no frog sits on the boulder', `${onRock} frames`)
check(strayed === 0, `no frog ever lands more than ${TETHER_M} m from home`, `furthest ${maxStray.toFixed(2)} m`)
check(alive().every((f) => f.state !== 'sit' || Math.abs(f.y - (GROUND + 0.05)) < 1e-6), 'a sitting frog is on the ground')
check(ms < 1.5, 'a frame costs well under a scatter', `${ms.toFixed(3)} ms/frame with ${alive().length} frogs`)
check(frogs.mesh.count === alive().length, 'the instance count is the live count', `${frogs.mesh.count}`)

// --- breathing: pin every frog sitting and watch instance 0's scale over one breath ----
{
  for (const f of alive()) { f.state = 'sit'; f.left = 1e9 }
  const e = frogs.mesh.instanceMatrix.array
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

// --- the cross card: far frogs leave the mesh for the card, under the same matrix, tint and hue ----
{
  const card = frogs.card
  check(card.parent === frogs.batch && !card.visible && card.count === 0, 'the card mesh rides in the batch, hidden until its picture is baked')
  const geo = card.geometry
  const pos = geo.getAttribute('position')
  const uv = geo.getAttribute('uv')
  const nrm = geo.getAttribute('normal')
  const xs = new Set(), zs = new Set()
  for (let i = 0; i < pos.count; i++) { xs.add(pos.getX(i).toFixed(3)); zs.add(pos.getZ(i).toFixed(3)) }
  check(pos.count === 8 && geo.index.count === 12 && xs.has('0.000') && zs.has('0.000') && xs.size === 3 && zs.size === 3, 'the card is two quads crossed on the body axis', `${pos.count} verts, ${geo.index.count} indices`)
  const sideU = [0, 1, 2, 3].map((i) => uv.getX(i)), frontU = [4, 5, 6, 7].map((i) => uv.getX(i))
  check(Math.max(...sideU) === 0.5 && Math.min(...frontU) === 0.5 && Math.max(...frontU) === 1, 'the side quad reads the left half of the picture, the front quad the right')
  // The side quad stands on the XY plane, feet down; the front quad on the ZY plane.
  const ys = [0, 1, 2, 3].map((i) => pos.getY(i))
  check([0, 1, 2, 3].every((i) => pos.getZ(i) === 0) && [4, 5, 6, 7].every((i) => pos.getX(i) === 0) && Math.min(...ys) < 0 && Math.max(...ys) > frogs.bounds.height, 'the side quad stands upright on the body\'s length, the front quad upright across it')
  let up = true
  for (let i = 0; i < nrm.count; i++) if (nrm.getY(i) !== 1) up = false
  check(up, 'every card normal points straight up, so the two planes take the same light')
  const m = frogs.cardMaterial
  check(m.alphaTest === 0.5 && m.side === THREE.DoubleSide, 'the card is a double-sided cutout', `alphaTest ${m.alphaTest}`)
  const shader = { vertexShader: '#include <common>', fragmentShader: '#include <clipping_planes_fragment>\n#include <normal_fragment_begin>' }
  m.onBeforeCompile(shader)
  check(/mod\( gl_FragCoord\.x \+ gl_FragCoord\.y, 2\.0 \) < 1\.0 \) discard/.test(shader.fragmentShader), 'the card discards every other pixel of a fixed screen checkerboard')
  check(/normal \*= faceDirection;/.test(shader.fragmentShader), 'and undoes the double-sided normal flip')
  check(m.customProgramCacheKey() !== frogs.material.customProgramCacheKey(), 'the card compiles its own program')

  frogs.place(0, 0)
  frogs.update(0, GROUND + 1.6, 0, DT)
  check(frogs.card.count === 0 && frogs.mesh.count === alive().length, 'before the bake every frog is the mesh')
  frogs.setCard(null)
  check(card.visible, 'setCard shows the card')
  const HEAD = [0, GROUND + 1.6, 0]
  frogs.update(...HEAD, DT)
  const at = (mesh, i) => { const e = mesh.instanceMatrix.array; return [e[i * 16 + 12], e[i * 16 + 13], e[i * 16 + 14]] }
  const dist = (p) => Math.hypot(p[0] - HEAD[0], p[1] - HEAD[1], p[2] - HEAD[2])
  const near = [], far = []
  for (let i = 0; i < frogs.mesh.count; i++) near.push(dist(at(frogs.mesh, i)))
  for (let i = 0; i < card.count; i++) far.push(dist(at(card, i)))
  check(frogs.mesh.count + card.count === alive().length && card.count > 0 && frogs.mesh.count > 0, 'the mesh and the card together hold every frog', `${frogs.mesh.count} mesh, ${card.count} card, ${alive().length} alive`)
  check(near.every((d) => d <= CARD_M) && far.every((d) => d > CARD_M), `the mesh holds the frogs within ${CARD_M} m of her head and the card the rest`, `mesh to ${Math.max(...near).toFixed(2)} m, card from ${Math.min(...far).toFixed(2)} m`)
  // A card instance is some far frog: same seat, same size (the matrix's scale up to the breath), same tint and hue. The buffers are float32.
  let matched = 0
  for (let i = 0; i < card.count; i++) {
    const e = card.instanceMatrix.array
    const p = at(card, i)
    const f = alive().find((g) => Math.abs(g.x - p[0]) < 1e-4 && Math.abs(g.z - p[2]) < 1e-4)
    if (!f) continue
    const sx = Math.hypot(e[i * 16], e[i * 16 + 1], e[i * 16 + 2]) * frogs.span
    const c = card.instanceColor.array
    const tint = Math.abs(c[i * 3] - f.r) < 1e-6 && Math.abs(c[i * 3 + 1] - f.g) < 1e-6 && Math.abs(c[i * 3 + 2] - f.b) < 1e-6
    if (Math.abs(sx / f.size - 1) < 0.3 && tint && Math.abs(frogs.cardHue.array[i] - f.hue) < 1e-6) matched++
  }
  check(matched === card.count, 'each card carries its frog\'s own matrix, tint and hue', `${matched} of ${card.count}`)
  // Walk her out to the far bank: what was card is mesh.
  frogs.update(HALF + 2, GROUND + 1.6, 40, DT)
  const swapped = []
  for (let i = 0; i < frogs.mesh.count; i++) swapped.push(at(frogs.mesh, i))
  check(swapped.some((p) => dist(p) > CARD_M), 'a frog she walks up to comes back as the mesh', `${swapped.length} in the mesh now`)
}

// Dry land far from any water: nothing.
frogs.place(500, 0)
frogs.update(500, GROUND, 0, DT)
check(alive().length === 0 && frogs.mesh.count === 0 && frogs.card.count === 0, 'no frogs away from water', `${alive().length} alive, mesh ${frogs.mesh.count}, card ${frogs.card.count}`)

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
if (failures) process.exit(1)
