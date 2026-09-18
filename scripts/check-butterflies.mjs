// Node-side gates for the butterflies (src/v2/render/butterflies.js).
//
//   node scripts/check-butterflies.mjs
//
// A synthetic meadow: a gentle slope with a snow line at 60 m, a pond, one
// tree, one boulder, one fern and one stump near the origin. Everything below
// is a way a butterfly can go wrong without anything throwing: rolled on snow
// or on water; a scatter that is not the same twice, or far off its density;
// a flier under FLY_M[0] or over FLY_M[1] above the ground, or one that never
// lands; a landing on water; a perch the trunk, the stone, the fern and the
// stump never get; a landed butterfly that does not sit on its perch with its
// up along the surface, or one whose wings do not raise and slow, or a flier
// whose wings do not flutter fast; one still in the air after sunset, one that
// takes off in the dark, a meadow rolled at night that arrives flying, or a
// whole meadow leaving on the one frame the sun comes up; a frame that costs
// more than a scatter is allowed to; the wing flap not in the vertex shader;
// a meadow all one colour, a butterfly whose tint is no morph of MORPHS, a
// blue that is not blue or an orange not orange, or an instance not carrying
// its butterfly's own tint.
// The shipped GLB is checked too, because the world loads it by name.
//
// What this can NOT check: whether the flight reads as a butterfly's. That
// needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import {
  Butterflies, CLIMB_TAN, DENSITY, DRAW_SPANS, FERN_LIFT_M, FLUTTER_AMP, FLUTTER_HZ, FLY_M, GLIDE_BASE, MAX, MORPHS, NEAR_M, NIGHT_DAY, RADIUS, REST_AMP, REST_BASE, REST_HZ, SIZE_M, SNOW_MARGIN, TILE,
} from '../src/v2/render/butterflies.js'
import { CRITTER_GLB } from '../src/v2/render/critters.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- the synthetic meadow ------------------------------------------------------
const SNOW = 60
const SLOPE = 0.05
const groundAt = (x, z) => 10 + x * SLOPE
const height = {
  heightAt: groundAt,
  heightAndSlopeAt: (x, z) => ({ h: groundAt(x, z), tan: SLOPE, gx: SLOPE, gz: 0 }),
  snowLineAt: () => SNOW,
}
// A pond 6 m across at (30, 30), its surface a hand above the ground at its uphill edge, so the whole disc is under water.
const POND = { x: 30, z: 30, r: 6 }
const water = { levelAt: (x, z) => (Math.hypot(x - POND.x, z - POND.z) < POND.r ? groundAt(POND.x + POND.r, POND.z) + 0.1 : null) }
const TREE = { x: 3, z: 0, r: 0.25 }
const ROCK = { x: -3, z: 0, r: 1.2 }
const FERN = { x: 0, z: 3, r: 0.5 }
const STUMP = { x: 0, z: -3, top: groundAt(0, -3) + 1.2, r: 0.3 }
const into = (list, x0, z0, x1, z1, out, fields) => {
  let n = 0
  for (const p of list) {
    if (p.x < x0 || p.x >= x1 || p.z < z0 || p.z >= z1) continue
    const o = n * 4
    const f = fields(p)
    out[o] = p.x; out[o + 1] = f.y; out[o + 2] = p.z; out[o + 3] = p.r
    n++
  }
  return n
}
const stoneAt = (x, z) => {
  const d2 = (x - ROCK.x) ** 2 + (z - ROCK.z) ** 2
  return d2 < ROCK.r * ROCK.r ? groundAt(ROCK.x, ROCK.z) + Math.sqrt(ROCK.r * ROCK.r - d2) : -Infinity
}
const rocks = {
  anchorsInto: (x0, z0, x1, z1, out) => into([ROCK], x0, z0, x1, z1, out, (p) => ({ y: groundAt(p.x, p.z) - 0.3 })),
  blockTopAt: (x, z, minSize, settle) => (settle === false ? stoneAt(x, z) : Math.max(stoneAt(x, z), -Infinity)),
}
const trees = { anchorsInto: (x0, z0, x1, z1, out) => into([TREE], x0, z0, x1, z1, out, (p) => ({ y: groundAt(p.x, p.z) - 0.1 })) }
// The fern answers at FERN_PERCH_STRIDE with its id, and `landOn` hands back one point of a tilted frond with its normal, as Ferns.landOn does off the rosette's triangles.
const FERN_HIT = { x: FERN.x + 0.3, y: groundAt(FERN.x, FERN.z) + 0.35, z: FERN.z + 0.1, nx: 0.6, ny: 0.8, nz: 0 }
const ferns = {
  perchesInto: (x0, z0, x1, z1, out) => {
    if (FERN.x < x0 || FERN.x >= x1 || FERN.z < z0 || FERN.z >= z1) return 0
    out[0] = FERN.x; out[1] = groundAt(FERN.x, FERN.z); out[2] = FERN.z; out[3] = FERN.r; out[4] = 17
    return 1
  },
  landOn: (id, rand, out) => {
    if (id !== 17) throw new Error(`landOn asked for fern ${id}, not the one perchesInto reported`)
    Object.assign(out, FERN_HIT)
  },
}
const deadwood = { perchesInto: (x0, z0, x1, z1, out) => into([STUMP], x0, z0, x1, z1, out, (p) => ({ y: p.top })) }
const walk = { heightAt: (x, z) => Math.max(groundAt(x, z), stoneAt(x, z)) }

// --- the shipped asset ---------------------------------------------------------
{
  const file = new URL(`../public/${CRITTER_GLB.butterfly}`, import.meta.url)
  check(fs.existsSync(file), `${CRITTER_GLB.butterfly} is shipped -- run tools/creatures/ship.mjs`)
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file)
    const json = JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)))
    const prim = json.meshes?.[0]?.primitives?.[0]
    check(json.meshes?.length === 1 && json.accessors[prim.indices].count === 12, 'two wing cards, four triangles', `${json.accessors?.[prim?.indices]?.count} indices`)
    const pos = json.accessors[prim.attributes.POSITION]
    check(pos.min[1] === 0 && pos.max[1] === 0 && pos.min[2] < 0 && pos.max[2] > 0, 'the cards lie flat in XZ with the seam at z = 0', `${pos.min} .. ${pos.max}`)
    check(Math.abs(pos.max[2] - pos.min[2] - 0.06) < 1e-3, 'the wingspan is the roster\'s 6 cm', String(pos.max[2] - pos.min[2]))
    check(json.materials?.[0]?.doubleSided === true && json.materials[0].alphaMode === 'MASK', 'double-sided and cut at alpha')
  }
}

// --- a stand-in asset: the two cards, in metres ----------------------------------
const asset = {
  pos: [0.02, 0, -0.03, 0.02, 0, 0, -0.02, 0, 0, -0.02, 0, -0.03, 0.02, 0, 0, 0.02, 0, 0.03, -0.02, 0, 0.03, -0.02, 0, 0],
  nrm: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  uv: [0, 0, 0.5, 0, 0.5, 1, 0, 1, 0.5, 0, 1, 0, 1, 1, 0.5, 1],
  idx: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
  map: null,
}

// --- construction and the shader hook -----------------------------------------
const scene = new THREE.Scene()
const make = (seed = 7) => new Butterflies(scene, height, water, { seed, walk, rocks, trees, ferns, deadwood, assets: asset })
const flock = make()
check(flock.loaded && flock.mesh.visible && Math.abs(flock.span - 0.06) < 1e-6, 'asset set: visible, span 6 cm', `span ${flock.span}`)
{
  const shader = { vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <normal_fragment_begin>\n' }
  flock.material.onBeforeCompile(shader)
  check(shader.vertexShader.includes('attribute vec3 aWing') && shader.vertexShader.includes('sin( aWing.x )') && shader.vertexShader.includes('transformed.y += abs( position.z ) * sin( wingAng )'), 'the flap turns each wing about the seam in begin_vertex')
  check(shader.vertexShader.indexOf('wingAng = ') < shader.vertexShader.indexOf('#include <begin_vertex>') && shader.vertexShader.includes('objectNormal = vec3( 0.0, cos( wingAng )'), 'the wing normal turns with the wing, worked out before the position stage')
  check(shader.fragmentShader.includes('normal *= faceDirection;'), 'both faces take the authored normal\'s light')
  check(flock.mesh.geometry.getAttribute('aWing').isInstancedBufferAttribute, 'aWing is per instance')
  check(flock.material.alphaTest === 0.5 && flock.material.side === THREE.DoubleSide, 'a double-sided cutout material')
}

// --- placement -----------------------------------------------------------------
const alive = (of = flock) => of.slots.filter((b) => b.tile !== null)
flock.place(0, 0)
{
  const n = alive().length
  const area = Math.PI * RADIUS * RADIUS
  check(n > 0 && n <= MAX, `placed ${n} butterflies in ${flock.tiles.size} tiles`)
  check(Math.abs(n / area - DENSITY) < DENSITY * 0.5, `density near ${DENSITY}/m2`, `${(n / area).toFixed(4)}/m2`)
  const again = make()
  again.place(0, 0)
  const key = (of) => alive(of).map((b) => `${b.homeX.toFixed(3)},${b.homeZ.toFixed(3)}`).sort().join('|')
  check(key(flock) === key(again), 'the same seed scatters the same butterflies')
  check(alive().every((b) => b.y >= b.ground + FLY_M[0] - 1e-6 && b.y <= b.ground + FLY_M[1] + 1e-6 && b.state === 'fly'), 'every butterfly starts in flight inside FLY_M')
}
{
  // On snow: the ground at x = 1000 is 60 m, the snow line.
  // The ground reaches SNOW - SNOW_MARGIN at x = 600, so the tiles around it straddle the cut.
  const cold = make()
  cold.place((SNOW - SNOW_MARGIN - 10) / SLOPE, 0)
  const under = alive(cold).filter((b) => b.ground > SNOW - SNOW_MARGIN)
  check(alive(cold).length > 0 && under.length === 0, 'none rolled within SNOW_MARGIN of the snow line', `${alive(cold).length} placed, ${under.length} too high`)
  const wet = make()
  wet.place(POND.x, POND.z)
  const onWater = alive(wet).filter((b) => Math.hypot(b.homeX - POND.x, b.homeZ - POND.z) < POND.r)
  check(onWater.length === 0 && alive(wet).length > 0, 'none rolled over the pond', `${onWater.length} wet of ${alive(wet).length}`)
  check(wet._groundPerch(wet.slots[0], POND.x, POND.z) === null && wet._groundPerch(wet.slots[0], POND.x + POND.r + 1, POND.z) === 'ground', 'the ground perch refuses the pond')
  // A minute at the pond's edge: the ones rolled on its shore wander over it, and must not land there.
  let wetLanding = 0, landed = 0
  for (let f = 0; f < 72 * 60; f++) {
    wet.update(POND.x + POND.r, 11, POND.z, 1 / 72)
    for (const b of alive(wet)) {
      if (b.state !== 'rest') continue
      landed++
      if (Math.hypot(b.x - POND.x, b.z - POND.z) < POND.r) wetLanding++
    }
  }
  check(landed > 0 && wetLanding === 0, 'no landing on the pond', `${wetLanding} wet of ${landed} resting frames`)
}

// --- the colour: one morph a butterfly, carried in instanceColor ----------------
{
  check(flock.mesh.instanceColor?.isInstancedBufferAttribute && flock.mesh.instanceColor.count === MAX, 'the tint rides in instanceColor')
  const within = (v, [lo, hi]) => v >= lo - 1e-9 && v <= hi + 1e-9
  const morphOf = (b) => MORPHS.find((m) => within(b.r, m.r) && within(b.g, m.g) && within(b.b, m.b))
  const worn = new Map(MORPHS.map((m) => [m.name, 0]))
  for (const b of alive()) { const m = morphOf(b); if (m) worn.set(m.name, worn.get(m.name) + 1) }
  check(alive().every((b) => morphOf(b)) && [...worn.values()].every((n) => n > 0), 'each butterfly wears one morph whole and every morph is on the meadow', [...worn].map(([k, v]) => `${k} ${v}`).join(', '))
  const mid = ([lo, hi]) => (lo + hi) / 2
  const meadow = MORPHS.find((m) => m.name === 'meadow'), blue = MORPHS.find((m) => m.name === 'blue'), orange = MORPHS.find((m) => m.name === 'orange')
  check(meadow && meadow.r[0] >= 0.9 && meadow.g[0] >= 0.9 && meadow.b[0] >= 0.8, 'the meadow morph is the map as shipped')
  check(blue && mid(blue.b) >= 0.9 && mid(blue.g) < 0.35 && mid(blue.r) < 0.05, 'the blue morph is an electric blue: full blue, little green, no red')
  check(orange && mid(orange.r) >= 0.95 && mid(orange.g) < 0.35 && mid(orange.g) > 0.1 && mid(orange.b) < 0.05, 'the orange morph is a flame orange: full red, some green, no blue')
  // One frame at the origin, then every written instance carries its butterfly's own tint.
  flock.update(0, 11, 0, 1 / 72)
  const c = flock.mesh.instanceColor.array, m = flock.mesh.instanceMatrix.array
  let matched = 0
  for (let k = 0; k < flock.mesh.count; k++) {
    const b = alive().find((b) => Math.abs(m[k * 16 + 12] - b.x) < 1e-4 && Math.abs(m[k * 16 + 14] - b.z) < 1e-4)
    if (b && Math.abs(c[k * 3] - b.r) < 1e-6 && Math.abs(c[k * 3 + 1] - b.g) < 1e-6 && Math.abs(c[k * 3 + 2] - b.b) < 1e-6) matched++
  }
  check(flock.mesh.count > 0 && matched === flock.mesh.count, 'each written instance carries its butterfly\'s tint', `${matched} of ${flock.mesh.count}`)
}

// --- flight and landing --------------------------------------------------------
{
  const dt = 1 / 72
  let low = 0, high = 0, seatOff = 0, upOff = 0, unwritten = 0, wingsOff = 0, frames = 0
  let maxMs = 0, totalMs = 0
  const landed = new Set()
  // The frame each butterfly last took off, so the rise from a ground perch is not read as flying low.
  const tookOff = new Map()
  const was = new Map(alive().map((b) => [b.id, b.state]))
  let phaseMax = 0
  // Where each flier was last frame, for the climb and the path checks; a flier's positions every half second, in 3 s windows.
  const prev = new Map()
  let steep = 0, steps = 0
  const trail = new Map()
  const chords = []
  let glided = 0, flapped = 0
  // The frame each approach began, and how long every finished one took: an approach that never seats is a butterfly circling its perch for the tile's life.
  const approach = new Map()
  const approaches = []
  // The matrix written for b this frame, or null when it was culled.
  const rowOf = (b) => {
    const m = flock.mesh.instanceMatrix.array
    for (let k = 0; k < flock.mesh.count; k++) if (Math.abs(m[k * 16 + 12] - b.x) < 1e-4 && Math.abs(m[k * 16 + 14] - b.z) < 1e-4) return k
    return null
  }
  // Two minutes of frames about the origin, where every kind of perch is in reach.
  for (let f = 0; f < 72 * 120; f++) {
    const t0 = performance.now()
    flock.update(0, 11, 0, dt)
    const ms = performance.now() - t0
    if (f > 10) { maxMs = Math.max(maxMs, ms); totalMs += ms; frames++ }
    for (const b of alive()) {
      phaseMax = Math.max(phaseMax, b.phase)
      if (b.state === 'fly' && was.get(b.id) !== 'fly') tookOff.set(b.id, f)
      if (b.state === 'land' && was.get(b.id) !== 'land') approach.set(b.id, f)
      if (b.state !== 'land' && approach.has(b.id)) { approaches.push((f - approach.get(b.id)) / 72); approach.delete(b.id) }
      was.set(b.id, b.state)
      if (b.state !== 'rest') {
        // Never straight up: a frame's rise is at most the run times CLIMB_TAN (the seat's snap on landing is a frame of the 'land' state, and is skipped).
        const p = prev.get(b.id)
        if (p && was.get(b.id) === b.state && b.state !== 'land') {
          const run = Math.hypot(b.x - p.x, b.z - p.z), rise = b.y - p.y
          steps++
          if (rise > run * CLIMB_TAN + 1e-4) steep++
        }
        prev.set(b.id, { x: b.x, y: b.y, z: b.z })
        if (b.amp > FLUTTER_AMP * 0.9) flapped++
        if (b.glide && Math.abs(b.base - GLIDE_BASE) < 0.05) glided++
      } else prev.delete(b.id)
      if (b.state === 'fly') {
        if (f % 36 === 0) {
          const t = trail.get(b.id) ?? []
          t.push([b.x, b.y, b.z])
          if (t.length === 7) {
            let path = 0
            for (let i = 1; i < 7; i++) path += Math.hypot(t[i][0] - t[i - 1][0], t[i][1] - t[i - 1][1], t[i][2] - t[i - 1][2])
            chords.push(Math.hypot(t[6][0] - t[0][0], t[6][1] - t[0][1], t[6][2] - t[0][2]) / path)
            t.length = 0
          }
          trail.set(b.id, t)
        }
        // The band is over the ground read every HEIGHT_EVERY frames and chased at a capped climb over the first seconds of a bout, so the boulder's metre step and the take-off are left out; a glide's sink and a stroke's bounce are the slack.
        if (Math.hypot(b.x - ROCK.x, b.z - ROCK.z) < ROCK.r + 2 || f - (tookOff.get(b.id) ?? 0) < 72 * 3) continue
        const g = walk.heightAt(b.x, b.z)
        if (b.y < g + FLY_M[0] - 0.05) low++
        if (b.y > g + FLY_M[1] + 0.05) high++
      } else if (b.state === 'rest') {
        landed.add(b.id)
        if (Math.hypot(b.x - b.px, b.y - b.py, b.z - b.pz) > 1e-6) seatOff++
        const k = rowOf(b)
        if (k === null) { if (Math.hypot(b.x, b.y - 11, b.z) < b.size * DRAW_SPANS) unwritten++; continue }
        // The card's up is the matrix's y column; it must be the perch's normal.
        const m = flock.mesh.instanceMatrix.array
        const s = Math.hypot(m[k * 16 + 4], m[k * 16 + 5], m[k * 16 + 6])
        if ((m[k * 16 + 4] * b.nx + m[k * 16 + 5] * b.ny + m[k * 16 + 6] * b.nz) / s < 0.999) upOff++
        const w = flock.wing.array
        if (w[k * 3] !== Math.fround(b.phase) || w[k * 3 + 1] !== Math.fround(b.amp) || w[k * 3 + 2] !== Math.fround(b.base)) wingsOff++
      }
    }
  }
  check(low === 0 && high === 0, 'every flier stays inside FLY_M over the ground under it', `${low} low, ${high} high`)
  check(landed.size > 0, `${landed.size} butterflies landed in two minutes`)
  // A perch is within SEARCH_M and at most FLY_M[1] up, so an approach is seconds; one still open at the end is a butterfly orbiting its perch.
  const APPROACH_S = 15
  for (const f0 of approach.values()) approaches.push((72 * 120 - f0) / 72)
  approaches.sort((a, b) => a - b)
  const circling = approaches.filter((s) => s > APPROACH_S).length
  check(approaches.length > 50 && circling === 0, `every landing approach seats within ${APPROACH_S} s`, `${circling} of ${approaches.length} longer, median ${approaches[approaches.length >> 1]?.toFixed(1)} s, max ${approaches[approaches.length - 1]?.toFixed(1)} s`)
  check(seatOff === 0 && upOff === 0 && unwritten === 0, 'a landed butterfly in reach is drawn on its perch with its up along the surface', `${seatOff} off the seat, ${upOff} tilted, ${unwritten} unwritten`)
  check(wingsOff === 0, 'aWing carries each instance\'s phase, amplitude and base')
  check(phaseMax < Math.PI * 2 + 1, 'the phase is kept to a turn, within float32\'s reach', `${phaseMax.toFixed(2)} rad after two minutes`)
  check(steps > 1000 && steep === 0, 'no butterfly ever rises steeper than CLIMB_TAN of its run', `${steep} of ${steps} airborne frames`)
  chords.sort((a, b) => a - b)
  const median = chords[chords.length >> 1]
  check(chords.length > 100 && median < 0.85 && chords[Math.floor(chords.length * 0.9)] < 0.97, 'a 3 s stretch of flight is not a straight line', `chord / path: median ${median.toFixed(2)}, 90th ${chords[Math.floor(chords.length * 0.9)].toFixed(2)} over ${chords.length} stretches`)
  check(glided > 0 && flapped > glided * 1.5, 'the wings beat in bursts with short glides between, held at GLIDE_BASE', `${flapped} flapping frames, ${glided} gliding`)
  check(alive().every((b) => b.size >= SIZE_M[0] && b.size <= SIZE_M[1]) && SIZE_M[0] === 0.05 && SIZE_M[1] === 0.2, 'wingspans run 5 to 20 cm', `${Math.min(...alive().map((b) => b.size)).toFixed(3)}..${Math.max(...alive().map((b) => b.size)).toFixed(3)} m`)
  // Each perch kind is one roll among the kinds in reach when a bout ends near it, so a rarer one may want a few minutes more.
  const L = flock.landings
  const allKinds = () => L.trunk > 0 && L.rock > 0 && L.fern > 0 && L.deadwood > 0 && L.ground > 0
  let more = 0
  for (; more < 72 * 240 && !allKinds(); more++) flock.update(0, 11, 0, dt)
  check(allKinds(), 'the trunk, the stone, the fern, the stump and the ground each got a landing', `${JSON.stringify(L)} after ${(more / 72).toFixed(0)} s more`)
  // A butterfly that has rested a second: its wings have had time to ease. `left` cannot say (a fresh landing may roll a short rest), so the frames are counted.
  const rested = new Map()
  let rest = null
  for (let f = 0; f < 72 * 30 && !rest; f++) {
    flock.update(0, 11, 0, dt)
    for (const b of alive()) {
      const n = b.state === 'rest' ? (rested.get(b.id) ?? 0) + 1 : 0
      rested.set(b.id, n)
      if (n >= 72) rest = b
    }
  }
  // A flier on the last frames of a flap burst (0.38 s of flapping at least, so the wings have eased from a glide's 0.08) within NEAR_M of her head, where it is stepped every frame; frames until one turns up.
  const nearFlier = () => alive().filter((b) => b.state === 'fly' && !b.glide && b.beat < 0.02 && Math.hypot(b.x, b.y - 11, b.z) < NEAR_M).sort((a, b) => a.beat - b.beat)[0]
  let flier = nearFlier()
  for (let f = 0; f < 72 * 30 && !flier; f++) { flock.update(0, 11, 0, dt); flier = nearFlier() }
  check(!!rest && Math.abs(rest.amp - REST_AMP) < 0.05 && Math.abs(rest.base - REST_BASE) < 0.05, 'a resting butterfly holds its wings raised, pulsing narrowly', rest ? `amp ${rest.amp.toFixed(2)} base ${rest.base.toFixed(2)}` : 'none resting')
  check(!!flier && Math.abs(flier.amp - FLUTTER_AMP) < 0.05 && Math.abs(flier.base) < 0.05, 'a flapping butterfly flutters wide about the flat', flier ? `amp ${flier.amp.toFixed(2)} base ${flier.base.toFixed(2)}` : 'none flying')
  check(REST_HZ < 1 && FLUTTER_HZ >= 8, 'the pulse is slow and the flutter fast', `${REST_HZ} Hz / ${FLUTTER_HZ} Hz`)
  if (flier) {
    const p0 = flier.phase
    flock.update(0, 11, 0, dt)
    const ran = (flier.phase - p0 + Math.PI * 2) % (Math.PI * 2)
    check(Math.abs(ran - Math.PI * 2 * FLUTTER_HZ * dt) < 1e-6, 'a flier\'s phase runs at FLUTTER_HZ', `${ran.toFixed(4)} rad in a frame`)
  }
  check(maxMs < 1 && totalMs / frames < 0.2, 'a frame of butterflies is cheap', `max ${maxMs.toFixed(3)} ms, mean ${(totalMs / frames).toFixed(3)} ms`)
}

// --- the trunk perch: on the bark, head up ---------------------------------------
{
  const b = alive()[0]
  b.x = TREE.x + 1; b.z = TREE.z + 1; b.y = groundAt(b.x, b.z) + 1
  let kind = null
  for (let i = 0; i < 64 && kind !== 'trunk'; i++) kind = flock._perch(b)
  check(kind === 'trunk', 'a trunk in reach is picked')
  if (kind === 'trunk') {
    check(Math.abs(Math.hypot(b.px - TREE.x, b.pz - TREE.z) - TREE.r) < 0.01 && Math.abs(b.ny) < 1e-6 && Math.abs(b.nx * (b.px - TREE.x) + b.nz * (b.pz - TREE.z) - TREE.r) < 0.01, 'the perch is on the bark, facing out', `${b.nx.toFixed(2)},${b.ny.toFixed(2)},${b.nz.toFixed(2)}`)
    const g = groundAt(TREE.x, TREE.z)
    check(b.py >= g + FLY_M[0] && b.py <= g + FLY_M[1], 'at a height in FLY_M up the trunk', `${(b.py - g).toFixed(2)} m`)
    // Seat it and read the matrix's x column: the body must point up the bark.
    b.perch = 'trunk'; b.state = 'rest'; b.left = 100
    b.x = b.px; b.y = b.py; b.z = b.pz
    // Seated by hand, so the frame is told: a sitter's matrix is otherwise kept.
    b.stale = true
    flock.update(0, 11, 0, 0)
    const m = flock.mesh.instanceMatrix.array
    let k = null
    for (let i = 0; i < flock.mesh.count; i++) if (Math.abs(m[i * 16 + 12] - b.x) < 1e-6 && Math.abs(m[i * 16 + 14] - b.z) < 1e-6) k = i
    const bodyUp = k !== null && m[k * 16 + 1] / Math.hypot(m[k * 16], m[k * 16 + 1], m[k * 16 + 2]) > 0.9999
    check(bodyUp, 'seated with its head up the trunk', k === null ? 'not written' : `${(m[k * 16 + 1] / Math.hypot(m[k * 16], m[k * 16 + 1], m[k * 16 + 2])).toFixed(4)}`)
    // A sitter is copied, not recomposed: _seat is not called for it again while it rests.
    const seat = flock._seat
    let seated = 0
    flock._seat = function (c) { if (c === b) seated++; return seat.call(this, c) }
    for (let i = 0; i < 72; i++) flock.update(0, 11, 0, 1 / 72)
    flock._seat = seat
    check(b.state === 'rest' && seated === 0, 'and a second of sitting recomposes its matrix on no frame', `${seated} seats`)
  }
}

// --- the fern perch: on a frond, lifted for the sway ------------------------------
{
  const b = alive()[0]
  b.x = FERN.x + 1; b.z = FERN.z + 1; b.y = groundAt(b.x, b.z) + 1
  let kind = null
  for (let i = 0; i < 64 && kind !== 'fern'; i++) kind = flock._perch(b)
  check(kind === 'fern', 'a fern in reach is picked')
  if (kind === 'fern') {
    const off = Math.hypot(b.px - FERN_HIT.x - FERN_HIT.nx * FERN_LIFT_M, b.py - FERN_HIT.y - FERN_HIT.ny * FERN_LIFT_M, b.pz - FERN_HIT.z - FERN_HIT.nz * FERN_LIFT_M)
    check(off < 1e-6 && FERN_LIFT_M >= 0.02 && FERN_LIFT_M <= 0.03, 'the perch is the frond\'s point, 2 to 3 cm off it along its normal', `${off.toExponential(1)} m off, lift ${FERN_LIFT_M}`)
    check(b.nx === FERN_HIT.nx && b.ny === FERN_HIT.ny && b.nz === FERN_HIT.nz, 'with the frond\'s normal, not straight up')
    // Flown in and seated: it rests exactly where the perch was set.
    b.state = 'land'; b.perch = 'fern'
    let f = 0
    for (; f < 72 * 30 && b.state === 'land'; f++) flock.update(0, 11, 0, 1 / 72)
    check(b.state === 'rest' && Math.hypot(b.x - b.px, b.y - b.py, b.z - b.pz) < 1e-6, 'and it settles onto that point', `${(f / 72).toFixed(1)} s in`)
  }
}

// --- after sunset nothing flies --------------------------------------------------
{
  const dt = 1 / 72
  const night = make(3)
  night.place(0, 0)
  const n0 = alive(night).length
  check(n0 > 0 && alive(night).every((b) => b.state === 'fly'), 'a meadow rolled in daylight starts in the air', `${n0} flying`)
  // Sundown, then a minute of it. NIGHT_DAY is the sun on the horizon.
  let settled = -1
  let flyingAfter = 0
  for (let f = 0; f < 72 * 60; f++) {
    night.update(0, 11, 0, dt, NIGHT_DAY - 0.05)
    const flying = alive(night).filter((b) => b.state !== 'rest').length
    if (flying === 0 && settled < 0) settled = f
    if (settled >= 0) flyingAfter += flying
  }
  check(settled >= 0 && settled < 72 * 30, 'every butterfly is down within half a minute of sundown', settled < 0 ? `${alive(night).filter((b) => b.state !== 'rest').length} still up after a minute` : `${(settled / 72).toFixed(1)} s`)
  check(flyingAfter === 0, 'and once down not one of them takes off again in the dark', `${flyingAfter} airborne butterfly-frames after`)
  check(alive(night).every((b) => Math.hypot(b.x - b.px, b.y - b.py, b.z - b.pz) < 1e-6 && b.perch !== null), 'each is sat on a perch, not hovering where it gave up', JSON.stringify(night.landings))
  check(alive(night).every((b) => Math.abs(b.amp - REST_AMP) < 1e-6 && Math.abs(b.base - REST_BASE) < 1e-6), 'with its wings raised and pulsing, as a resting butterfly holds them')

  // A tile that grows in the dark arrives seated: she walks a long way after sunset and the new meadow is not a cloud of fliers.
  night.update(400, groundAt(400, 0) + 1.6, 0, dt, 0)
  const fresh = alive(night)
  check(fresh.length > 0 && fresh.every((b) => b.state === 'rest'), 'a meadow rolled in the dark arrives already landed', `${fresh.filter((b) => b.state === 'rest').length} of ${fresh.length} seated`)
  check(fresh.every((b) => Math.hypot(b.x - b.px, b.y - b.py, b.z - b.pz) < 1e-6), 'each on the perch it found, not floating over one')
  // The seating happens in the tile generator, so it must not have spent the flock's own stream: the same seed, in the dark, lays the same butterflies.
  const twin = make(3)
  twin.dayness = 0
  twin.place(400, 0)
  const key = (of) => alive(of).map((b) => `${b.homeX.toFixed(4)},${b.homeZ.toFixed(4)},${b.size.toFixed(4)}`).sort().join('|')
  check(key(twin) === key(night), 'and the night scatter is the same pure function of the seed the day one is')
  twin.dispose()

  // Dawn: they do not all leave on the frame the sun clears the horizon.
  const first = new Map()
  for (let f = 0; f < 72 * 60; f++) {
    night.update(400, groundAt(400, 0) + 1.6, 0, dt, 1)
    for (const b of alive(night)) if (b.state !== 'rest' && !first.has(b.id)) first.set(b.id, f / 72)
  }
  const offs = [...first.values()].sort((a, b) => a - b)
  check(offs.length > fresh.length / 2, 'the meadow is up again in the morning', `${offs.length} of ${fresh.length} left their perch in a minute`)
  check(offs.length > 0 && offs[offs.length - 1] - offs[0] > 3, 'and they go a few at a time, not all on one frame', `first at ${offs[0].toFixed(1)} s, last at ${offs[offs.length - 1].toFixed(1)} s`)
  night.dispose()
}

// --- the tiles follow her ------------------------------------------------------
{
  flock.update(200, 21, 0, 1 / 72)
  check(alive().every((b) => Math.hypot(b.homeX - 200, b.homeZ) < RADIUS + TILE), 'a move frees the tiles left behind and rolls the new ones')
}

console.log(failures ? `\n${failures} failure(s)` : '\nall butterfly checks passed')
process.exit(failures ? 1 : 0)
