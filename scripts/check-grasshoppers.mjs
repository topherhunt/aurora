// Node-side gates for the grasshoppers (src/v2/render/grasshoppers.js).
//
//   node scripts/check-grasshoppers.mjs
//
// A synthetic meadow: a gentle slope with a snow line at 60 m, a pond, a
// boulder and a cliff near the origin. Everything below is a way a
// grasshopper can go wrong without anything throwing: a shipped GLB that is
// not packed onto a 128 px WebP, over its triangle budget, or facing off +X;
// rolled on snow, on water or on a cliff; a
// scatter that is not the same twice, or far off its density; a length off
// 8 cm by more than a fifth, or a tint that is not a mix of the two ends, or a
// meadow all one colour; one seated off the walk surface or not up along the
// slope, or drawn at a scale other than its length over the mesh's; a hop
// shorter or longer than HOP_M, lower or higher over its chord,
// or landing off the walk surface, on the pond or past the tether; a hop not
// wound up by a crouch, or one whose apex is not at RISE_FRAC, whose launch
// speed does not bleed away, or whose drop in is not steeper than its
// take-off; a landing that does not settle; a rest outside REST_S; a body
// that does not pitch up on the way up and down on the way down; one past
// SHOW_M that is drawn, listed or stepped; a frame that costs more than a
// scatter is allowed; a hop in the dark, or a dawn that launches them all
// on one frame.
//
// What this can NOT check: whether a hop reads as a grasshopper's. That needs
// eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import {
  CROUCH_S, CROUCH_SQUASH, DENSITY, Grasshoppers, HOP_M, LAND_S, LAND_SQUASH, LENGTH_M, MAX, MAX_SLOPE_DEG, NIGHT_DAY, RADIUS, REST_S, RISE_FRAC, SHADE, SHOW_M, SNOW_MARGIN, TETHER, TILE, TINT_BROWN, TINT_GREEN,
} from '../src/v2/render/grasshoppers.js'
import { CRITTER_GLB } from '../src/v2/render/critters.js'
import { TEX_PX_SMALL } from '../tools/creatures/creature-roster.mjs'
import { webpSize } from '../tools/tripo-pack.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- the synthetic meadow ------------------------------------------------------
const SNOW = 60
const SLOPE = 0.05
// A cliff: from x = 40 the ground climbs at 45 degrees for CLIFF_H, then the slope goes on.
const CLIFF_X = 40
const CLIFF_H = 20
const groundAt = (x, z) => 10 + x * SLOPE + Math.min(CLIFF_H, Math.max(0, x - CLIFF_X))
const slopeAt = (x) => (x > CLIFF_X && x < CLIFF_X + CLIFF_H ? 1 + SLOPE : SLOPE)
const height = {
  heightAt: groundAt,
  heightAndSlopeAt: (x, z) => ({ h: groundAt(x, z), tan: slopeAt(x), gx: slopeAt(x), gz: 0 }),
  snowLineAt: () => SNOW,
}
// A pond 6 m across at (0, 20), its surface a hand above the ground at its uphill edge, so the whole disc is under water.
const POND = { x: 0, z: 20, r: 6 }
const water = { levelAt: (x, z) => (Math.hypot(x - POND.x, z - POND.z) < POND.r ? groundAt(POND.x + POND.r, POND.z) + 0.1 : null) }
// A boulder at (-3, 0): the walk surface is its dome.
const ROCK = { x: -3, z: 0, r: 1.2 }
const stoneAt = (x, z) => {
  const d2 = (x - ROCK.x) ** 2 + (z - ROCK.z) ** 2
  return d2 < ROCK.r * ROCK.r ? groundAt(ROCK.x, ROCK.z) + Math.sqrt(ROCK.r * ROCK.r - d2) : -Infinity
}
const walk = { heightAt: (x, z) => Math.max(groundAt(x, z), stoneAt(x, z)) }
const within = (v, [lo, hi], eps = 1e-6) => v >= lo - eps && v <= hi + eps

// --- the shipped asset -------------------------------------------------------
{
  const file = new URL(`../public/${CRITTER_GLB.grasshopper}`, import.meta.url)
  check(fs.existsSync(file), `${CRITTER_GLB.grasshopper} is shipped -- run tools/creatures/ship.mjs`)
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file)
    check(buf.toString('latin1', 0, 4) === 'glTF', 'the grasshopper GLB has a glTF header')
    const jsonLen = buf.readUInt32LE(12)
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen))
    check(json.meshes?.length === 1 && json.meshes[0].primitives.length === 1, 'one mesh, one primitive', `${json.meshes?.length} meshes`)
    // Packed (tools/creatures/ship.mjs): the colour map is a WebP beside the GLB at the roster's small size, and Tripo's own JPEGs -- colour, ORM, normal -- are gone.
    const image = json.images?.[0]
    check(image?.uri?.endsWith('.webp') && image.bufferView === undefined && json.images.length === 1, 'the one image is the packed WebP beside the GLB, not an embedded JPEG', JSON.stringify(json.images))
    check(image?.uri && fs.existsSync(new URL(image.uri, file)), 'and it is shipped')
    if (image?.uri && fs.existsSync(new URL(image.uri, file))) {
      const { width, height } = webpSize(fs.readFileSync(new URL(image.uri, file)))
      check(width === TEX_PX_SMALL && height === TEX_PX_SMALL, `the colour map is ${TEX_PX_SMALL}px square`, `${width}x${height}`)
    }
    check(json.extensionsRequired?.includes('EXT_texture_webp') && json.textures?.[0]?.extensions?.EXT_texture_webp?.source === 0, 'the texture declares EXT_texture_webp')
    const pbr = json.materials?.[0]?.pbrMetallicRoughness
    check(pbr?.metallicFactor === 0 && pbr.metallicRoughnessTexture === undefined && json.materials[0].normalTexture === undefined, 'no metalness, and the ORM and normal maps are gone', JSON.stringify(json.materials?.[0]))
    const node = json.nodes.find((n) => n.mesh !== undefined)
    check(!node.rotation && !node.translation && !node.scale, 'the mesh node carries its transform as one matrix')
    // The mesh after the node's matrix -- ship.mjs turns the pick there by the roster's faceTurnDeg.
    const m = node.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const prim = json.meshes[0].primitives[0]
    const acc = json.accessors[prim.attributes.POSITION]
    const view = json.bufferViews[acc.bufferView]
    const at = 20 + jsonLen + 8 + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
    const pos = new Float32Array(buf.buffer.slice(buf.byteOffset + at, buf.byteOffset + at + acc.count * 12))
    const pts = []
    for (let i = 0; i < acc.count; i++) {
      const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2]
      pts.push([m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13]])
    }
    const tris = json.accessors[prim.indices].count / 3
    check(tris <= 300, 'a low-fidelity body: 300 triangles or fewer', `${tris} tris`)
    const xMin = Math.min(...pts.map((p) => p[0])), xMax = Math.max(...pts.map((p) => p[0]))
    const yMin = Math.min(...pts.map((p) => p[1])), yMax = Math.max(...pts.map((p) => p[1]))
    // Facing: the antennae lead, so the foremost tenth along +X hangs wholly in the air, and the rearmost tenth -- the hind feet and the tail -- reaches the ground.
    const lowest = (from, to) => Math.min(...pts.filter((p) => p[0] >= from && p[0] < to).map((p) => p[1]))
    const front = lowest(xMax - (xMax - xMin) * 0.1, Infinity), back = lowest(-Infinity, xMin + (xMax - xMin) * 0.1)
    check(front > yMin + (yMax - yMin) * 0.4 && back < yMin + (yMax - yMin) * 0.1, 'the grasshopper faces +X: its antennae lead in the air, its hind feet trail on the ground', `front tenth's lowest ${((front - yMin) / (yMax - yMin)).toFixed(2)} of the height, back tenth's ${((back - yMin) / (yMax - yMin)).toFixed(2)}`)
  }
}

// --- a stand-in asset: a unit box, feet at y = 0 --------------------------------
const boxAsset = () => {
  const box = new THREE.BoxGeometry(1, 0.5, 0.7, 2, 2, 2).translate(0, 0.25, 0)
  return { pos: box.getAttribute('position').array, nrm: box.getAttribute('normal').array, uv: box.getAttribute('uv').array, idx: Array.from(box.index.array), map: null }
}

// --- construction ----------------------------------------------------------------
const scene = new THREE.Scene()
const make = (seed = 7) => new Grasshoppers(scene, height, water, { seed, walk, assets: boxAsset() })
const flock = make()
check(flock.loaded && flock.mesh.visible && flock.mesh.parent === flock.batch && Math.abs(flock.length - 1) < 1e-6, 'asset set: visible in the batch, length 1', `length ${flock.length}`)
check(flock.mesh.isInstancedMesh && flock.mesh.instanceMatrix.count === MAX && flock.batch.children.length === 1, 'one InstancedMesh of MAX slots: every shown grasshopper is one draw call')
check(flock.material.isMeshLambertMaterial && flock.material.alphaTest === 0 && flock.material.side === THREE.FrontSide && !flock.material.transparent, 'a plain single-sided Lambert: no cutout, no glint')
check(!flock.mesh.frustumCulled && flock.mesh.instanceMatrix.usage === THREE.DynamicDrawUsage, 'never frustum culled, matrices dynamic')

// --- placement -----------------------------------------------------------------
const alive = (of = flock) => of.slots.filter((g) => g.tile !== null)
flock.place(0, 0)
{
  const n = alive().length
  const want = flock.tiles.size * TILE * TILE * DENSITY
  check(n > 0 && n <= MAX, `placed ${n} grasshoppers in ${flock.tiles.size} tiles`)
  // The pond's edge takes a few of the resident tiles' rolls.
  check(Math.abs(n - want) < want * 0.3, `density near ${DENSITY}/m2 over the resident tiles`, `${n} of ${want} rolled`)
  check(RADIUS >= SHOW_M + (TILE * Math.SQRT2) / 2 - 1e-9, 'the resident tiles cover every point within SHOW_M')
  const again = make()
  again.place(0, 0)
  const key = (of) => alive(of).map((g) => `${g.homeX.toFixed(3)},${g.homeZ.toFixed(3)}`).sort().join('|')
  check(key(flock) === key(again), 'the same seed scatters the same grasshoppers')
  check(alive().every((g) => g.state === 'sit' && within(g.left, REST_S) && within(g.len, LENGTH_M)), 'every grasshopper starts seated, its rest in REST_S, its length in LENGTH_M')
  check(Math.abs((LENGTH_M[0] + LENGTH_M[1]) / 2 - 0.08) < 1e-9 && Math.abs(LENGTH_M[0] - 0.08 * 0.8) < 1e-9 && Math.abs(LENGTH_M[1] - 0.08 * 1.2) < 1e-9, 'LENGTH_M is 8 cm, a fifth either way')
  const shortest = Math.min(...alive().map((g) => g.len)), longest = Math.max(...alive().map((g) => g.len))
  check(longest / shortest > 1.3, 'the lengths spread across the range', `${(shortest * 100).toFixed(1)}-${(longest * 100).toFixed(1)} cm`)
  check(alive().every((g) => Math.abs(g.y - walk.heightAt(g.x, g.z)) < 1e-9), 'every one sits on the walk surface')
  const onStone = alive().filter((g) => stoneAt(g.x, g.z) > -Infinity)
  check(onStone.length > 0 && onStone.every((g) => g.y > groundAt(g.x, g.z)), 'the ones on the boulder sit on its dome, not the field under it', `${onStone.length} on the stone`)
  // Seated up along the slope: the field rises 0.05 in x, so the normal leans -x.
  flock.update(0, 11, 0, 1 / 72)
  const m = flock.mesh.instanceMatrix.array
  let leaning = 0, scaled = 0
  for (let k = 0; k < flock.mesh.count; k++) {
    const up = [m[k * 16 + 4], m[k * 16 + 5], m[k * 16 + 6]]
    const len = Math.hypot(...up)
    if (Math.abs(up[0] / len + SLOPE / Math.hypot(1, SLOPE)) < 1e-5 && Math.abs(up[1] / len - 1 / Math.hypot(1, SLOPE)) < 1e-5) leaning++
    // The instances are written in shown order; a seated body's X column is its length over the mesh's.
    if (Math.abs(Math.hypot(m[k * 16], m[k * 16 + 1], m[k * 16 + 2]) - flock.shown[k].len / flock.length) < 1e-6) scaled++
  }
  check(flock.mesh.count > 0 && leaning === flock.mesh.count, 'every written instance stands up along the slope', `${leaning} of ${flock.mesh.count}`)
  check(scaled === flock.mesh.count, 'and is drawn at its length over the mesh\'s X extent', `${scaled} of ${flock.mesh.count}`)
  // The tint: each written instance's colour is a mix of the two ends by a shade, and the meadow holds greener and browner ones.
  const tint = flock.mesh.instanceColor.array
  let inGamut = 0, greener = 0, browner = 0
  for (let k = 0; k < flock.mesh.count; k++) {
    const c = [tint[k * 3], tint[k * 3 + 1], tint[k * 3 + 2]]
    // The red-to-green ratio is free of the shade, so it gives the mix; the shade is then what green is over the mix's.
    const D = TINT_BROWN.map((v, i) => v - TINT_GREEN[i])
    const mix = (c[0] * TINT_GREEN[1] - c[1] * TINT_GREEN[0]) / (c[1] * D[0] - c[0] * D[1])
    const shade = c[1] / (TINT_GREEN[1] + D[1] * mix)
    const fits = Math.abs(c[2] - (TINT_GREEN[2] + D[2] * mix) * shade) < 1e-5
    if (fits && within(mix, [0, 1], 1e-3) && within(shade, SHADE, 1e-3)) inGamut++
    if (c[1] > c[0]) greener++
    if (c[0] > c[1]) browner++
  }
  check(inGamut === flock.mesh.count, 'every written tint is a mix of TINT_GREEN and TINT_BROWN by a SHADE', `${inGamut} of ${flock.mesh.count}`)
  check(greener > 0 && browner > 0, 'some are greener than the map and some browner', `${greener} greener, ${browner} browner of ${flock.mesh.count}`)
  check(flock.mesh.instanceColor.usage === THREE.DynamicDrawUsage, 'the tints are dynamic')
}
{
  const cold = make()
  cold.place((SNOW - SNOW_MARGIN - 10 - CLIFF_H) / SLOPE, 0)
  const under = alive(cold).filter((g) => groundAt(g.x, g.z) > SNOW - SNOW_MARGIN)
  check(alive(cold).length > 0 && under.length === 0, 'none rolled within SNOW_MARGIN of the snow line', `${alive(cold).length} placed, ${under.length} too high`)
  const wet = make()
  wet.place(POND.x, POND.z)
  const onWater = alive(wet).filter((g) => Math.hypot(g.homeX - POND.x, g.homeZ - POND.z) < POND.r)
  check(onWater.length === 0 && alive(wet).length > 0, 'none rolled on the pond', `${onWater.length} wet of ${alive(wet).length}`)
  const steep = make()
  steep.place(CLIFF_X, 0)
  const onCliff = alive(steep).filter((g) => g.homeX > CLIFF_X && g.homeX < CLIFF_X + CLIFF_H)
  check(onCliff.length === 0 && alive(steep).length > 0, `none rolled on ground steeper than ${MAX_SLOPE_DEG} degrees`, `${onCliff.length} on the cliff of ${alive(steep).length}`)
}

// --- the hops ------------------------------------------------------------------
{
  const dt = 1 / 72
  const hop = make(3)
  hop.place(0, 0)
  const flights = new Map()
  const crouched = new Map()
  const landings = new Map()
  let bad = 0, rests = 0, badRest = 0, badLanding = 0, offTether = 0, pitchWrong = 0, badCrouch = 0, badLand = 0, unCrouched = 0, settled = 0
  let apexAt = 0, halfWay = 0, steeper = 0, flown = 0
  let maxMs = 0
  for (let f = 0; f < 72 * 90; f++) {
    const t0 = performance.now()
    hop.update(0, 11, 0, dt)
    if (f >= 72) maxMs = Math.max(maxMs, performance.now() - t0)
    for (const g of hop.shown) {
      if (g.state === 'crouch') {
        // The wind-up: seated where it was, sinking toward the ground.
        const c = crouched.get(g) ?? { x: g.x, squash: 1, frames: 0 }
        if (g.x !== c.x || g.squash > c.squash || g.squash < CROUCH_SQUASH - 1e-9 || g.pitch !== 0) badCrouch++
        c.squash = g.squash; c.frames++
        crouched.set(g, c)
      } else if (g.state === 'hop') {
        let r = flights.get(g)
        if (!r) {
          const c = crouched.get(g)
          if (!c || c.frames < Math.floor(CROUCH_S / dt) - 1) unCrouched++
          crouched.delete(g)
          r = { dist: Math.hypot(g.x1 - g.x0, g.z1 - g.z0), apex: g.apex, y1: g.y1, x1: g.x1, z1: g.z1, high: -Infinity, low: Infinity, yWas: g.y0, rose: 0, pitchWas: 0, sAtHigh: 0, half: null, pitch0: Math.abs(g.pitch), pitchEnd: 0 }
          flights.set(g, r)
          if (!within(r.dist, HOP_M) || !within(r.apex, HOP_M)) bad++
          if (Math.abs(g.y1 - walk.heightAt(g.x1, g.z1)) > 1e-9 || water.levelAt(g.x1, g.z1) !== null) badLanding++
          if (Math.hypot(g.x1 - g.homeX, g.z1 - g.homeZ) > TETHER + HOP_M[1] + 1e-9) offTether++
        }
        const s = g.t / g.T
        if (g.squash !== 1) bad++
        // The chord under the body is read off the ground it has covered, so the lift over it is the code's shape, not its formula.
        const covered = Math.hypot(g.x - g.x0, g.z - g.z0) / r.dist
        const lift = g.y - (g.y0 + (g.y1 - g.y0) * covered)
        if (lift > r.high) { r.high = lift; r.sAtHigh = s }
        r.low = Math.min(r.low, lift)
        if (r.half === null && s >= 0.5) r.half = covered
        r.pitchEnd = Math.abs(g.pitch)
        // The nose follows the path: the last frame's pitch is wrong when the body fell both before and after it with the nose up, or rose both sides with it down.
        const rose = g.y - r.yWas
        if ((r.pitchWas > 0 && r.rose < -1e-6 && rose < -1e-6) || (r.pitchWas < 0 && r.rose > 1e-6 && rose > 1e-6)) pitchWrong++
        r.yWas = g.y; r.rose = rose; r.pitchWas = g.pitch
      } else if (flights.has(g)) {
        // Touched down: on the landing point, level, the settle begun, the rest rolled.
        const r = flights.get(g)
        rests++
        if (g.state !== 'land' || !within(g.left, REST_S) || g.pitch !== 0 || Math.abs(g.x - r.x1) > 1e-9 || Math.abs(g.y - r.y1) > 1e-9) badRest++
        if (r.high > r.apex + 1e-6 || r.high < r.apex * 0.9 || r.low < -1e-9) bad++
        // Rises for RISE_FRAC of the flight, covers more than half its ground by half its time, drops in steeper than it left.
        flown++
        if (Math.abs(r.sAtHigh - RISE_FRAC) < 0.06) apexAt++
        if (r.half > 0.6) halfWay++
        if (r.pitchEnd > r.pitch0) steeper++
        flights.delete(g)
        landings.set(g, { x: g.x, squash: 1, frames: 0, dipped: false })
      } else if (landings.has(g)) {
        const l = landings.get(g)
        if (g.state === 'land') {
          // The settle: squashed and back, going nowhere.
          if (g.x !== l.x || g.squash < LAND_SQUASH - 1e-9 || g.squash > 1) badLand++
          if (g.squash < 0.9) l.dipped = true
          l.frames++
        } else {
          settled++
          if (g.state !== 'sit' || g.squash !== 1 || !l.dipped || l.frames < Math.floor(LAND_S / dt) - 1) badLand++
          landings.delete(g)
        }
      }
    }
  }
  check(hop.hops > 20 && rests > 20, `grasshoppers hop: ${hop.hops} hops, ${rests} landings in 90 s`)
  check(unCrouched === 0 && badCrouch === 0, `every hop is wound up by a crouch of CROUCH_S, sinking to CROUCH_SQUASH without moving`, `${unCrouched} unwound, ${badCrouch} bad frames`)
  check(bad === 0, 'every hop is HOP_M long and HOP_M high over its chord, reaches its apex, is never under the chord, and flies unsquashed', `${bad} bad`)
  check(flown > 20 && apexAt === flown, `the apex comes at RISE_FRAC of the flight`, `${apexAt} of ${flown}`)
  check(halfWay === flown, 'more than 60% of the ground is covered by half the flight: the launch speed bleeds away', `${halfWay} of ${flown}`)
  check(steeper === flown, 'the drop in is steeper than the take-off', `${steeper} of ${flown}`)
  check(badLanding === 0, 'every landing is on the walk surface, off the pond', `${badLanding} bad`)
  check(badRest === 0, 'a landed grasshopper is level on its landing point with its rest rolled in REST_S', `${badRest} bad`)
  check(settled > 20 && badLand === 0, 'the landing settles for LAND_S -- squashed to LAND_SQUASH and back up, going nowhere -- then it sits', `${settled} settled, ${badLand} bad`)
  check(offTether === 0, `no landing past TETHER + a hop from home`, `${offTether} off`)
  check(pitchWrong === 0, 'nose up on the way up, down on the way down', `${pitchWrong} frames wrong`)
  check(maxMs < 2, 'a frame of the layer costs under 2 ms, once warm', `${maxMs.toFixed(3)} ms worst`)
}

// --- night ---------------------------------------------------------------------
{
  const dt = 1 / 72
  const dark = make(9)
  dark.place(0, 0)
  check(Math.abs(DENSITY - 1 / 16) < 1e-12, 'DENSITY is one per 16 m2')
  // Day until one is in the air, then the sun goes down under it.
  let frames = 0
  while (!dark.shown.some((g) => g.state === 'hop') && frames++ < 72 * 30) dark.update(0, 11, 0, dt, 1)
  const aloft = dark.shown.filter((g) => g.state === 'hop')
  check(aloft.length > 0, 'one is in the air when the sun goes down', `${aloft.length} aloft`)
  const hopsAtDusk = dark.hops
  for (let f = 0; f < 72 * 60; f++) dark.update(0, 11, 0, dt, NIGHT_DAY - 0.01)
  check(aloft.every((g) => g.state === 'sit' && Math.abs(g.y - walk.heightAt(g.x, g.z)) < 1e-9), 'it finishes its hop and sits')
  check(dark.hops === hopsAtDusk && dark.shown.every((g) => g.state === 'sit' && g.left > 0 && g.left <= REST_S[1]), 'no grasshopper hops in the dark for a minute, each seated on a rest still running', `${dark.hops - hopsAtDusk} hops`)
  check(dark.bodies([]).length === dark.shown.length && dark.shown.length > 0, 'the seated ones are still listed for the ambience to chirp', `${dark.shown.length}`)
  // Dawn: the rests re-rolled in the dark are still running down, so the launches are spread over REST_S -- a minority in the first second, most within the longest rest.
  const shown = dark.shown.slice()
  for (let f = 0; f < 72; f++) dark.update(0, 11, 0, dt, 1)
  check(dark.hops - hopsAtDusk < shown.length * 0.6, 'at dawn only a minority hop in the first second', `${dark.hops - hopsAtDusk} of ${shown.length}`)
  for (let f = 0; f < 72 * REST_S[1]; f++) dark.update(0, 11, 0, dt, 1)
  check(dark.hops - hopsAtDusk >= shown.length * 0.8, `and most have hopped within REST_S[1] of it`, `${dark.hops - hopsAtDusk} hops from ${shown.length}`)
}

// --- only within SHOW_M ----------------------------------------------------------
{
  const dt = 1 / 72
  const far = make(5)
  far.place(0, 0)
  const near = () => alive(far).filter((g) => Math.hypot(g.x, g.y - 11, g.z) <= SHOW_M)
  far.update(0, 11, 0, dt)
  const listed = far.bodies([])
  check(far.mesh.count === near().length && listed.length === near().length && listed.every((g) => Math.hypot(g.x, g.y - 11, g.z) <= SHOW_M), `only the ones within ${SHOW_M} m are written and listed`, `${far.mesh.count} of ${alive(far).length}`)
  // One past SHOW_M with a short rest: a minute later it has not moved, and it is not the mesh's.
  const held = alive(far).find((g) => Math.hypot(g.x, g.z) > SHOW_M + 1)
  held.left = 0.5
  const was = { x: held.x, z: held.z, left: held.left }
  for (let f = 0; f < 72 * 60; f++) far.update(0, 11, 0, dt)
  check(held.x === was.x && held.z === was.z && held.left === was.left && held.state === 'sit', 'a grasshopper past SHOW_M is not stepped')
  // Stand over it and it goes.
  for (let f = 0; f < 72 * 5; f++) far.update(held.x, groundAt(held.x, held.z) + 1.6, held.z, dt)
  check(held.x !== was.x || held.z !== was.z, 'and it hops once she is near')
  far.update(200, 21, 0, dt)
  check(alive(far).every((g) => Math.hypot(g.homeX - 200, g.homeZ) < RADIUS + TILE), 'a move frees the tiles left behind and rolls the new ones')
}

console.log(failures ? `\n${failures} failure(s)` : '\nall grasshopper checks passed')
process.exit(failures ? 1 : 0)
