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
// shorter or longer than HOP_M, lower or higher over its chord than a kick
// in LAUNCH_DEG gives its distance, or in the air longer than gravity's rise
// and a FALL_G fall take, or landing off the walk surface, on the pond or
// past the tether; a hop not wound up by a crouch, or one whose apex is not
// at RISE_FRAC, whose launch speed does not bleed away, or whose drop in is
// not steeper than its take-off where it does not land higher than it left; a
// landing that does not settle; a rest
// outside REST_S; two clients on different frame rates, or one joining late,
// drawing different poses at the same world second; a release that does not
// reach the room, or does not put the one grasshopper on the one spot on the
// client it reaches (the only thing a grasshopper sends); a body
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
  APEX_MAX, CROUCH_S, CROUCH_SQUASH, DENSITY, dropKey, FALL_G, Grasshoppers, GRAVITY, HOP_M, LAND_S, LAND_SQUASH, LAUNCH_DEG, LENGTH_M, MAX, MAX_SLOPE_DEG, NIGHT_DAY, RADIUS, REST_S, RISE_FRAC, SHADE, SHOW_M, SNOW_MARGIN, TETHER, TILE, TINT_BROWN, TINT_GREEN,
} from '../src/v2/render/grasshoppers.js'
import { GRID_S, keyHash } from '../src/sim/score.js'
import { taken } from '../src/v2/taken.js'
import { CRITTER_GLB, tileKey } from '../src/v2/render/critters.js'
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
  check(alive().every((g) => g.state === 'sit' && g.seg === null && within(g.len, LENGTH_M)), 'every grasshopper starts seated with nothing planned, its length in LENGTH_M')
  check(alive().every((g) => g.key === `gh:${Math.floor(g.homeX / TILE)},${Math.floor(g.homeZ / TILE)}:${g.index}` && g.offset === keyHash(g.key) % GRID_S), 'each is keyed by its tile and its place in the roll, on its own grid')
  check(Math.abs((LENGTH_M[0] + LENGTH_M[1]) / 2 - 0.08) < 1e-9 && Math.abs(LENGTH_M[0] - 0.08 * 0.8) < 1e-9 && Math.abs(LENGTH_M[1] - 0.08 * 1.2) < 1e-9, 'LENGTH_M is 8 cm, a fifth either way')
  const shortest = Math.min(...alive().map((g) => g.len)), longest = Math.max(...alive().map((g) => g.len))
  check(longest / shortest > 1.3, 'the lengths spread across the range', `${(shortest * 100).toFixed(1)}-${(longest * 100).toFixed(1)} cm`)
  check(alive().every((g) => Math.abs(g.y - walk.heightAt(g.x, g.z)) < 1e-9), 'every one sits on the walk surface')
  const onStone = alive().filter((g) => stoneAt(g.x, g.z) > -Infinity)
  check(onStone.length > 0 && onStone.every((g) => g.y > groundAt(g.x, g.z)), 'the ones on the boulder sit on its dome, not the field under it', `${onStone.length} on the stone`)
  // Seated up along the slope: the field rises 0.05 in x, so the normal leans -x.
  flock.update(0, 11, 0, 0)
  const m = flock.mesh.instanceMatrix.array
  let leaning = 0, scaled = 0, seated = 0
  for (let k = 0; k < flock.mesh.count; k++) {
    const up = [m[k * 16 + 4], m[k * 16 + 5], m[k * 16 + 6]]
    const len = Math.hypot(...up)
    if (flock.shown[k].state !== 'hop') {
      seated++
      if (Math.abs(up[0] / len + SLOPE / Math.hypot(1, SLOPE)) < 1e-5 && Math.abs(up[1] / len - 1 / Math.hypot(1, SLOPE)) < 1e-5) leaning++
    }
    // The instances are written in shown order; a seated body's X column is its length over the mesh's.
    if (Math.abs(Math.hypot(m[k * 16], m[k * 16 + 1], m[k * 16 + 2]) - flock.shown[k].len / flock.length) < 1e-6) scaled++
  }
  check(seated > 0 && leaning === seated, 'every written instance on the ground stands up along the slope', `${leaning} of ${seated}`)
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
// Everything a grasshopper does is arithmetic on its plan, so the frame only
// samples it: the driver walks world time forward by dt and reads the phrase
// the layer chose off the slot.
const drive = (of, { from = 0, secs, dt = 1 / 72, x = 0, y = 11, z = 0, dayness = 1, each = null }) => {
  let now = from
  const end = from + secs
  while (now < end) {
    of.update(x, y, z, now, dayness)
    each?.(now)
    now += dt
  }
  return now
}
{
  const dt = 1 / 72
  const hop = make(3)
  hop.place(0, 0)
  const flights = new Map()
  const crouched = new Map()
  const landings = new Map()
  let bad = 0, badTime = 0, rests = 0, badRest = 0, badLanding = 0, offTether = 0, pitchWrong = 0, badCrouch = 0, badLand = 0, unCrouched = 0, settled = 0
  let apexAt = 0, halfWay = 0, steeper = 0, fell = 0, flown = 0, longHops = 0
  let maxMs = 0
  // A grasshopper walks into SHOW_M mid-bout, and the frames before that are not the gate's to judge: one is watched only from the first sit after it comes into view.
  const skip = new Set()
  let wasShown = new Set()
  drive(hop, { from: 1000, secs: 90, dt, each: () => {
    for (const g of hop.shown) {
      if (!wasShown.has(g)) {
        skip.add(g)
        crouched.delete(g); flights.delete(g); landings.delete(g)
      }
      if (skip.has(g)) {
        if (g.state !== 'sit') continue
        skip.delete(g)
      }
      const ph = g.phrase
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
          const { from: p0, to: p1 } = ph
          r = { frames: 0, dist: Math.hypot(p1.x - p0.x, p1.z - p0.z), apex: ph.apex, p0, p1, high: -Infinity, low: Infinity, yWas: p0.y, rose: 0, pitchWas: 0, sAtHigh: 0, half: null, pitch0: Math.abs(g.pitch), pitchEnd: 0 }
          flights.set(g, r)
          // The apex is the rolled distance's under a kick in LAUNCH_DEG, capped at APEX_MAX; the flight lasts gravity's rise to it plus a fall under FALL_G gravities.
          const apexOf = (deg) => Math.min(APEX_MAX, (r.dist * Math.tan((deg * Math.PI) / 180)) / 4)
          if (!within(r.apex, [apexOf(LAUNCH_DEG[0]), apexOf(LAUNCH_DEG[1])])) bad++
          // Every hop is HOP_M long bar a recovery hop straight onto a post, which is at most the width of the tether and no higher for it.
          if (!within(r.dist, HOP_M)) { longHops++; if (r.dist > 2 * TETHER + 1e-9 || r.apex > APEX_MAX + 1e-9) bad++ }
          const rise = Math.sqrt((2 * r.apex) / GRAVITY)
          if (Math.abs(ph.dur - (rise + rise / Math.sqrt(FALL_G))) > 1e-9) badTime++
          if (Math.abs(p1.y - walk.heightAt(p1.x, p1.z)) > 1e-9) badLanding++
          if (Math.hypot(p1.x - g.homeX, p1.z - g.homeZ) > TETHER + 1e-9) offTether++
        }
        const s = g.elapsed / ph.dur
        r.frames++
        if (g.squash !== 1) bad++
        // The chord under the body is read off the ground it has covered, so the lift over it is the code's shape, not its formula.
        const covered = Math.hypot(g.x - r.p0.x, g.z - r.p0.z) / r.dist
        const lift = g.y - (r.p0.y + (r.p1.y - r.p0.y) * covered)
        if (lift > r.high) { r.high = lift; r.sAtHigh = s }
        r.low = Math.min(r.low, lift)
        if (r.half === null && s >= 0.5) r.half = covered
        r.pitchEnd = Math.abs(g.pitch)
        // The nose follows the path: the last frame's pitch is wrong when the body fell both before and after it with the nose up, or rose both sides with it down.
        const rose = g.y - r.yWas
        if ((r.pitchWas > 0 && r.rose < -1e-6 && rose < -1e-6) || (r.pitchWas < 0 && r.rose > 1e-6 && rose > 1e-6)) pitchWrong++
        r.yWas = g.y; r.rose = rose; r.pitchWas = g.pitch
      } else if (flights.has(g)) {
        // Touched down: on the landing point, level, the settle begun.
        const r = flights.get(g)
        flights.delete(g)
        rests++
        if (g.state !== 'land' || g.pitch !== 0 || Math.abs(g.x - r.p1.x) > 1e-9 || Math.abs(g.y - r.p1.y) > 1e-9) badRest++
        if (r.high > r.apex + 1e-6 || r.high < r.apex * 0.9 || r.low < -1e-9) bad++
        // Rises for RISE_FRAC of the flight, covers more than half its ground by half its time, drops in steeper than it left. A flight the frame caught twice or fewer says nothing about any of that.
        if (r.frames > 2) {
          flown++
          if (Math.abs(r.sAtHigh - RISE_FRAC) < 0.06) apexAt++
          if (r.half > 0.6) halfWay++
          // A hop onto the boulder climbs further than its apex and so is nose-up the whole way: there is no drop in to be steeper than the take-off.
          if (r.p1.y <= r.p0.y + 1e-9) {
            fell++
            if (r.pitchEnd > r.pitch0) steeper++
          }
        }
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
      // A sit between two hops of one bout is a rest in REST_S, squeezed only to fit the segment out.
      if (ph.kind === 'sit' && ph.dur > REST_S[1] + 1e-9 && ph !== g.seg.phrases[0] && ph !== g.seg.phrases[g.seg.phrases.length - 1]) badRest++
    }
    wasShown = new Set(hop.shown)
  } })
  {
    const t0 = performance.now()
    hop.update(0, 11, 0, 1100)
    maxMs = performance.now() - t0
  }
  check(hop.hops > 20 && rests > 20, `grasshoppers hop: ${hop.hops} hops, ${rests} landings in 90 s`)
  check(unCrouched === 0 && badCrouch === 0, `every hop is wound up by a crouch of CROUCH_S, sinking to CROUCH_SQUASH without moving`, `${unCrouched} unwound, ${badCrouch} bad frames`)
  check(bad === 0, 'every hop is as high over its chord as a kick in LAUNCH_DEG gives it up to APEX_MAX, reaches its apex, is never under the chord, and flies unsquashed', `${bad} bad`)
  check(longHops < flown * 0.2, 'nearly every hop is HOP_M long: a recovery hop straight onto a post is the exception', `${longHops} of ${flown} longer`)
  check(badTime === 0 && RISE_FRAC > 0.5, 'every flight lasts gravity\'s rise to its apex plus a fall under FALL_G gravities, the fall the shorter', `${badTime} bad, RISE_FRAC ${RISE_FRAC.toFixed(3)}`)
  check(flown > 20 && apexAt === flown, `the apex comes at RISE_FRAC of the flight`, `${apexAt} of ${flown}`)
  check(halfWay === flown, 'more than 60% of the ground is covered by half the flight: the launch speed bleeds away', `${halfWay} of ${flown}`)
  check(fell > 20 && steeper === fell, 'a hop that does not land higher than it left drops in steeper than it took off', `${steeper} of ${fell}`)
  check(badLanding === 0, 'every landing is on the walk surface', `${badLanding} bad`)
  check(badRest === 0, 'a landed grasshopper is level on its landing point, and a rest between two hops is in REST_S', `${badRest} bad`)
  check(settled > 20 && badLand === 0, 'the landing settles for LAND_S -- squashed to LAND_SQUASH and back up, going nowhere -- then it sits', `${settled} settled, ${badLand} bad`)
  check(offTether === 0, `no landing past TETHER from home`, `${offTether} off`)
  check(pitchWrong === 0, 'nose up on the way up, down on the way down', `${pitchWrong} frames wrong`)
  check(maxMs < 2, 'a frame of the layer costs under 2 ms, once warm', `${maxMs.toFixed(3)} ms`)
  // The posts are the ends of the segments: every landing is dry, and nothing hops onto the pond.
  let wet = 0
  for (const g of alive(hop)) if (g.seg) for (const ph of g.seg.phrases) if (ph.kind === 'land' && water.levelAt(ph.at.x, ph.at.z) !== null) wet++
  check(wet === 0, 'no bout lands on the pond', `${wet} wet landings`)
}

// --- the same on every client ------------------------------------------------
// The contract (_notes/creature-sync.md): the pose at a world second is a pure
// function of the key and that second, so two clients on different frame rates,
// one of them meeting the meadow late, draw the same grasshopper in the same
// place.
{
  const pose = (of) => alive(of).map((g) => `${g.key}|${g.x.toFixed(9)},${g.y.toFixed(9)},${g.z.toFixed(9)}|${g.yaw.toFixed(9)},${g.pitch.toFixed(9)}|${g.squash.toFixed(9)}|${g.state}`).sort().join('\n')
  const slow = make(13); slow.place(0, 0)
  const fast = make(13); fast.place(0, 0)
  // 40 s apiece from the same world second, one at 24 fps and one at 144, with a stutter in the slow one.
  drive(slow, { from: 5000, secs: 40, dt: 1 / 24 })
  let odd = 5000
  for (let k = 0; k < 400; k++) { fast.update(0, 11, 0, odd); odd += (k % 7 === 0 ? 0.4 : 1 / 144) }
  slow.update(0, 11, 0, 5040)
  fast.update(0, 11, 0, 5040)
  check(pose(slow) === pose(fast) && slow.shown.length > 0, 'two clients on different frame rates draw the same meadow at the same world second', `${slow.shown.length} shown`)
  // A third joins at 5040 having never stepped: same poses from its first frame.
  const joined = make(13); joined.place(0, 0)
  joined.update(0, 11, 0, 5040)
  check(pose(joined) === pose(slow), 'and so does one meeting the meadow at that second, from its first frame')
  // Mid-hop, not merely at a turn: step them all to a second at which somebody is in the air.
  let aloft = null
  for (let t = 5040; t < 5060 && aloft === null; t += 1 / 30) {
    slow.update(0, 11, 0, t)
    if (slow.shown.some((g) => g.state === 'hop')) aloft = t
  }
  const late = make(13); late.place(0, 0)
  late.update(0, 11, 0, aloft)
  check(aloft !== null && pose(late) === pose(slow), 'including one that joins mid-hop', `at ${aloft?.toFixed(3)}`)
  // Nothing is sent for any of this.
  check(slow.pending().length === 0 && typeof slow.applyLured !== 'function', 'and a grasshopper on its plan owes the room nothing: no anchor, no lured set')

  // The one thing a grasshopper does send: the release, without which a peer watches it go into a hand and never land.
  const dropped = (of) => alive(of).find((g) => g.key.startsWith('gh@'))
  const rec = { kind: 'grasshopper', size: 0.081, color: [0.7, 1.1, 0.6] }
  check(slow.release(rec, 1.0004, groundAt(1.0004, 1.0004), 1.0004, null, aloft), 'a grasshopper let go here is let go')
  const owed = slow.pending()
  check(owed.length === 1 && slow.pending().length === 0, 'and is owed to the room once', `${owed.length} anchor`)
  const drop = owed[0]
  check(drop[0].startsWith('gh:') && /^[a-z0-9:,-]{1,32}$/.test(drop[0]) && drop[7] === 'drop' && drop[8] === null && Number.isInteger(drop[6]), "as one anchor in mode drop under the grasshoppers' prefix", drop[0])
  check(JSON.stringify(drop).length <= 256, "inside the relay's 256 bytes", `${JSON.stringify(drop).length} bytes`)
  drop[8] = 'peer'
  late.apply(drop, aloft)
  const there = dropped(late)
  check(there && late.pending().length === 0, 'the peer told of it lets the same grasshopper go, and owes it nobody')
  check(there && there.key === dropped(slow).key && there.r === 0.7 && there.len === rec.size, 'on the same key, in the same tint', there?.key)
  late.apply(drop, aloft)
  check(alive(late).filter((g) => g.key.startsWith('gh@')).length === 1, 'and a second telling -- a fresh welcome -- lets no second grasshopper go')
  slow.apply(drop, aloft)
  check(alive(slow).filter((g) => g.key.startsWith('gh@')).length === 1, 'nor does her own drop come back to her')
  for (let k = 0; k < 24 * 20; k++) { const t = aloft + k / 24; slow.update(0, 11, 0, t); late.update(0, 11, 0, t) }
  check(pose(late) === pose(slow) && Math.hypot(dropped(slow).x - 1.0004, dropped(slow).z - 1.0004) > 0.2, 'and twenty seconds on they are watching the one grasshopper hop the one way', `${Math.hypot(dropped(slow).x - 1.0004, dropped(slow).z - 1.0004).toFixed(2)} m off`)
}

// --- night ---------------------------------------------------------------------
{
  const dark = make(9)
  dark.place(0, 0)
  check(Math.abs(DENSITY - 1 / 16) < 1e-12, 'DENSITY is one per 16 m2')
  // Day until one is in the air, then the sun goes down under it.
  let now = 2000
  while (!dark.shown.some((g) => g.state === 'hop') && now < 2030) { dark.update(0, 11, 0, now, 1); now += 1 / 72 }
  const aloft = dark.shown.filter((g) => g.state === 'hop')
  check(aloft.length > 0, 'one is in the air when the sun goes down', `${aloft.length} aloft`)
  // It finishes the hop it is on: no teleport at the turn.
  const wasAt = aloft.map((g) => ({ g, x: g.x, z: g.z }))
  now = drive(dark, { from: now, secs: 2, dayness: NIGHT_DAY - 0.01 })
  check(wasAt.every(({ g, x, z }) => Math.hypot(g.x - x, g.z - z) < HOP_M[1] + 1e-9), 'it finishes its hop rather than jumping home')
  // Within two segments every one of them is home, and there it stays for a minute.
  now = drive(dark, { from: now, secs: 2 * GRID_S, dayness: NIGHT_DAY - 0.01 })
  const home = () => dark.shown.filter((g) => g.state === 'sit' && Math.abs(g.x - g.homeX) < 1e-9 && Math.abs(g.z - g.homeZ) < 1e-9)
  check(dark.shown.length > 0 && home().length === dark.shown.length, 'every grasshopper is home and seated two segments after sunset', `${home().length} of ${dark.shown.length}`)
  const hopsAtNight = dark.hops
  now = drive(dark, { from: now, secs: 60, dayness: NIGHT_DAY - 0.01 })
  check(dark.hops === hopsAtNight && home().length === dark.shown.length, 'and none hops in the dark for a minute', `${dark.hops - hopsAtNight} hops`)
  check(dark.bodies([]).length === dark.shown.length && dark.shown.length > 0, 'the seated ones are still listed for the ambience to chirp', `${dark.shown.length}`)
  // Dawn: each waits for its own segment's turn, and the grids are offset, so the meadow does not launch on one frame.
  const shown = dark.shown.slice()
  const start = now
  now = drive(dark, { from: now, secs: 1, dayness: 1 })
  check(dark.hops - hopsAtNight < shown.length * 0.6, 'at dawn only a minority hop in the first second', `${dark.hops - hopsAtNight} of ${shown.length}`)
  drive(dark, { from: now, secs: GRID_S + REST_S[1] + 2, dayness: 1 })
  check(dark.hops - hopsAtNight >= shown.length * 0.8, `and most have hopped within a segment and a rest of it`, `${dark.hops - hopsAtNight} hops from ${shown.length}, ${(performance.now() && GRID_S + REST_S[1] + 3).toFixed(0)} s`)
  check(start > 0, 'dawn is read off the clock, not the frame')
}

// --- only within SHOW_M ----------------------------------------------------------
{
  const far = make(5)
  far.place(0, 0)
  const near = () => alive(far).filter((g) => Math.hypot(g.x, g.y - 11, g.z) <= SHOW_M)
  far.update(0, 11, 0, 300)
  const listed = far.bodies([])
  check(far.mesh.count === near().length && listed.length === near().length && listed.every((g) => Math.hypot(g.x, g.y - 11, g.z) <= SHOW_M), `only the ones within ${SHOW_M} m are written and listed`, `${far.mesh.count} of ${alive(far).length}`)
  // One past SHOW_M: a minute of world time later it has not moved and has planned nothing.
  const held = alive(far).find((g) => Math.hypot(g.x, g.z) > SHOW_M + 1)
  const was = { x: held.x, z: held.z }
  drive(far, { from: 300, secs: 60 })
  check(held.x === was.x && held.z === was.z && held.seg === null && held.state === 'sit', 'a grasshopper past SHOW_M is not posed and plans nothing')
  // Stand over it and it goes, on the plan it would have been on all along.
  drive(far, { from: 360, secs: 2 * GRID_S, x: held.x, y: groundAt(held.x, held.z) + 1.6, z: held.z })
  check(held.seg !== null && (held.x !== was.x || held.z !== was.z), 'and it picks its plan up once she is near')
  far.update(200, 21, 0, 400)
  check(alive(far).every((g) => Math.hypot(g.homeX - 200, g.homeZ) < RADIUS + TILE), 'a move frees the tiles left behind and rolls the new ones')
}

// --- her hands -------------------------------------------------------------------
{
  const grow = () => { const f = make(11); f.place(0, 0); f.update(0, groundAt(0, 0) + 1.6, 0, 700); return f }
  const f = grow()
  check(f.shown.length > 0, 'grasshoppers are shown around her')
  const g = f.shown[0]
  const hit = f.pickAt(g.x, g.y + g.len * 0.5, g.z, 0.3)
  check(hit !== null && hit.g === g && hit.dist === 0 && Math.abs(hit.size - g.len) < 1e-9, 'pickAt at a shown grasshopper hits it, its size its length', JSON.stringify(hit && { dist: hit.dist, size: hit.size }))
  check(f.pickAt(g.x, g.y + 5, g.z, 0.3) === null, 'and nothing 5 m above it')
  const far = alive(f).find((h) => Math.hypot(h.x, h.z) > SHOW_M + 1)
  check(far && f.pickAt(far.x, far.y, far.z, 0.3) === null, 'one past SHOW_M is not offered: it is not stepped')
  const were = alive(f).length
  const home = { x: g.homeX, z: g.homeZ }
  const tile = g.tile
  const rec = f.take(hit)
  check(rec.kind === 'grasshopper' && rec.name === 'grasshopper' && rec.size === g.len && rec.geometry === f.mesh.geometry && rec.material === f.material && rec.stowable === true, 'take: a stowable grasshopper on the shared geometry and material')
  check(Math.abs(rec.scale[0] - g.len / f.length) < 1e-9 && rec.scale[1] === rec.scale[0] && rec.scale[2] === rec.scale[0] && rec.color.length === 3, 'scaled by its length over the asset, tinted', JSON.stringify(rec.scale))
  check(g.tile === null && !tile.flock.includes(g) && f.free.includes(g) && !f.shown.includes(g) && alive(f).length === were - 1, 'its slot is back in the pool, out of its flock and off the shown list')
  check(taken.has('grasshopper', home.x, home.z), 'its home is recorded taken')
  check(f.pickAt(g.x, g.y + g.len * 0.5, g.z, 0.3)?.g !== g, 'and it cannot be taken twice')
  const d = f.dress({ kind: 'grasshopper' })
  check(d.geometry === f.mesh.geometry && d.material === f.material, 'dress: the shared geometry and material')
  let threw = false
  try { f.dress({ kind: 'crab' }) } catch { threw = true }
  check(threw, 'dress throws on another kind')
  const bare = new Grasshoppers(scene, height, water, { seed: 11, walk })
  check(bare.dress({ kind: 'grasshopper' }) === null && bare.pickAt(0, 0, 0, 100) === null, 'unloaded: dress is null and pickAt offers nothing')
  // Regrown, the tile has one fewer, and once the registry is cleared it comes back.
  const again = grow()
  check(alive(again).length === were - 1 && !alive(again).some((h) => Math.hypot(h.homeX - home.x, h.homeZ - home.z) < 0.05), 'the tile regrows without the taken one')
  taken.clear()
  {
    // A peer's catch: evicted by home within the registry's tolerance, shown or not; a foreign key, an empty spot and a home once emptied are false.
    const ge = grow()
    const e = alive(ge).find((h) => Math.hypot(h.x, h.z) > SHOW_M + 1)
    const n0 = alive(ge).length
    check(ge.evict('cricket', e.homeX, e.homeZ) === false && ge.evict('grasshopper', e.homeX + 5, e.homeZ) === false && alive(ge).length === n0, 'evict is false for a foreign key or an empty spot')
    check(ge.evict('grasshopper', e.homeX + 0.03, e.homeZ - 0.03) === true && e.tile === null && alive(ge).length === n0 - 1 && taken.has('grasshopper', e.homeX, e.homeZ), 'evict takes the grasshopper a peer caught out of its flock, unshown past SHOW_M, and records its home')
    check(ge.evict('grasshopper', e.homeX, e.homeZ) === false, 'and is false for the home once emptied')
    ge.dispose()
    taken.clear()
  }
  check(alive(grow()).length === were, 'and with the registry cleared it is back')
  // Let go on the meadow: seated there in the resident tile, home there, and off in a hop.
  const rel = f.release(rec, 3, groundAt(3, 5), 5)
  const seated = alive(f).find((h) => h.homeX === 3 && h.homeZ === 5)
  check(rel === true && seated && seated.x === 3 && seated.z === 5 && seated.y === walk.heightAt(3, 5) && seated.len === rec.size && seated.tile === f.tiles.get(tileKey(Math.floor(3 / TILE), Math.floor(5 / TILE))), 'release seats it on the ground at the drop, in the tile under it')
  check(seated && seated.r === rec.color[0] && seated.g === rec.color[1] && seated.b === rec.color[2] && seated.seg === null, 'in its own tint, with nothing planned yet')
  check(seated.key === dropKey(3, 5) && seated.offset === keyHash(seated.key) % GRID_S, 'its key is the drop point, so a peer told the same point plans the same life', seated.key)
  drive(f, { from: 700, secs: 2 * GRID_S, y: groundAt(0, 0) + 1.6 })
  check(seated.x !== 3 || seated.z !== 5, 'and it hops off')
  check(f.release(rec, POND.x, groundAt(POND.x, POND.z), POND.z) === false, 'release into the pond is refused')
  check(f.release(rec, 500, groundAt(500, 0), 0) === false, 'and where no tile is resident')
}

console.log(failures ? `\n${failures} failure(s)` : '\nall grasshopper checks passed')
process.exit(failures ? 1 : 0)
