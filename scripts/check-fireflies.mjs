// Node-side gates for the fireflies (src/v2/render/fireflies.js).
//
//   node scripts/check-fireflies.mjs
//
// A synthetic wood: a gentle slope with a snow line at 60 m, a pond, and a
// grove of trunks on one side of the origin with open field on the other.
// Everything below is a way a firefly can go wrong without anything throwing:
// one rolled by day, on snow, on water, or out in the open away from any tree;
// a scatter that is not the same twice; a grove whose trees land late and
// never gets its fireflies; one under FLY_M[0] or over FLY_M[1] above the
// ground, or one that leaves its tether; a flash that is not short, a dark
// spell that is not long, or a swarm that blinks in step; a glow that is on
// by day or off at midnight, or one the instance does not carry; a frame that
// costs more than a swarm is allowed to; a sunrise that leaves the swarm up.
//
// What this can NOT check: whether the flash reads as a firefly's in the
// dark. That needs eyes, in the world.

import * as THREE from 'three'
import {
  DARK_DAY, DENSITY, FLY_M, Fireflies, MAX, NIGHT_DAY, OFF_S, ON_S, RADIUS, SNOW_MARGIN, TETHER, TILE, TREE_M,
} from '../src/v2/render/fireflies.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- the synthetic wood --------------------------------------------------------
const SNOW = 60
const SLOPE = 0.05
const groundAt = (x, z) => 10 + x * SLOPE
const height = { heightAt: groundAt, snowLineAt: () => SNOW }
const POND = { x: 30, z: 30, r: 6 }
const water = { levelAt: (x, z) => (Math.hypot(x - POND.x, z - POND.z) < POND.r ? groundAt(POND.x + POND.r, POND.z) + 0.1 : null) }
const walk = { heightAt: groundAt }
// A grove: trunks every 5 m over x in [-40, 0), nothing east of the origin. `grown` is whether the trees have landed yet.
const grove = []
for (let x = -40; x < 0; x += 5) for (let z = -40; z < 40; z += 5) grove.push({ x: x + 1.3, z: z + 2.1 })
const trees = {
  grown: true,
  anchorsInto(x0, z0, x1, z1, out) {
    if (!this.grown) return 0
    let n = 0
    for (const p of grove) {
      if (p.x < x0 || p.x >= x1 || p.z < z0 || p.z >= z1) continue
      if (n * 4 + 4 > out.length) break
      out[n * 4] = p.x; out[n * 4 + 1] = groundAt(p.x, p.z) - 0.2; out[n * 4 + 2] = p.z; out[n * 4 + 3] = 0.3
      n++
    }
    return n
  },
}
const nearTree = (x, z) => grove.some((p) => Math.hypot(p.x - x, p.z - z) < TREE_M)

const scene = new THREE.Scene()
const make = (seed = 7) => new Fireflies(scene, height, water, { seed, walk, trees })
const alive = (of) => of.slots.filter((b) => b.tile !== null)
const MIDNIGHT = 0
const NOON = 1
const dt = 1 / 72

// --- construction ---------------------------------------------------------------
const swarm = make()
check(swarm.mesh.geometry.getAttribute('aGlow').isInstancedBufferAttribute && swarm.mesh.geometry.index.count === 6, 'one quad a firefly, the glow per instance')
check(swarm.material.transparent && swarm.material.premultipliedAlpha && !swarm.material.depthWrite && swarm.material.fog === false, 'a premultiplied transparent draw that writes no depth')
check(swarm.material.fragmentShader.includes('gl_FragColor = vec4( uGlow * ( lit * halo ) + uBodyColor * dark, dark )'), 'the halo adds and the body covers, in one fragment')

// --- day and night ---------------------------------------------------------------
{
  swarm.place(0, 0)
  check(alive(swarm).length === 0 && swarm.tiles.size === 0, 'nothing placed before the clock says night (dayness defaults to noon)')
  swarm.update(0, 11, 0, dt, NOON)
  check(alive(swarm).length === 0 && swarm.mesh.count === 0, 'nothing by day')
  swarm.update(0, 11, 0, dt, NIGHT_DAY)
  check(alive(swarm).length === 0, 'nothing with the sun exactly at NIGHT_DAY')
  swarm.update(-10, 11, 0, dt, MIDNIGHT)
  const n = alive(swarm).length
  check(n > 0 && n <= MAX && swarm.mesh.count === n, `the swarm comes out at midnight: ${n} in ${swarm.tiles.size} tiles`)
  check(swarm.gain === 1 && swarm.material.uniforms.uGain.value === 1, 'the glow is full at midnight')
  swarm.update(-10, 11, 0, dt, (NIGHT_DAY + DARK_DAY) / 2)
  check(Math.abs(swarm.gain - 0.5) < 1e-9, 'and half way up half way between NIGHT_DAY and DARK_DAY', String(swarm.gain))
  swarm.update(-10, 11, 0, dt, NOON)
  check(alive(swarm).length === 0 && swarm.tiles.size === 0 && swarm.mesh.count === 0, 'sunrise takes the whole swarm down')
}

// --- placement -------------------------------------------------------------------
{
  swarm.update(-10, 11, 0, dt, MIDNIGHT)
  const all = alive(swarm)
  check(all.every((b) => nearTree(b.homeX, b.homeZ)), 'every firefly is within TREE_M of a trunk')
  check(all.every((b) => b.homeX < TREE_M), 'none out in the open field', `east-most ${Math.max(...all.map((b) => b.homeX)).toFixed(1)}`)
  // The wooded ground of the resident tiles, counted on a metre grid.
  let wooded = 0
  for (const t of swarm.tiles.values()) for (let x = 0.5; x < TILE; x++) for (let z = 0.5; z < TILE; z++) if (nearTree(t.tx * TILE + x, t.tz * TILE + z)) wooded++
  check(Math.abs(all.length / wooded - DENSITY) < DENSITY * 0.5, `density in the wood near ${DENSITY}/m2`, `${(all.length / wooded).toFixed(4)}/m2 over ${wooded} m2`)
  const again = make()
  again.update(-10, 11, 0, dt, MIDNIGHT)
  const key = (of) => alive(of).map((b) => `${b.homeX.toFixed(3)},${b.homeZ.toFixed(3)}`).sort().join('|')
  check(key(swarm) === key(again), 'the same seed scatters the same fireflies')
  check(all.every((b) => b.y >= b.ground + FLY_M[0] - 1e-6 && b.y <= b.ground + FLY_M[1] + 1e-6 && !b.on), 'every firefly starts dark inside FLY_M')
  const spread = new Set(all.map((b) => Math.round(b.left * 4))).size
  check(spread > all.length / 4, 'their dark spells are staggered', `${spread} distinct quarter-seconds left over ${all.length}`)
  again.dispose()
}
{
  // On snow: the ground reaches SNOW - SNOW_MARGIN at x = 600, so a grove there straddles the cut.
  const cx = (SNOW - SNOW_MARGIN - 10) / SLOPE
  for (let x = -30; x < 30; x += 5) for (let z = -30; z < 30; z += 5) grove.push({ x: cx + x, z })
  const cold = make()
  cold.update(cx, groundAt(cx, 0) + 1.6, 0, dt, MIDNIGHT)
  const under = alive(cold).filter((b) => b.ground > SNOW - SNOW_MARGIN)
  check(alive(cold).length > 0 && under.length === 0, 'none rolled within SNOW_MARGIN of the snow line', `${alive(cold).length} placed, ${under.length} too high`)
  cold.dispose()
  for (let x = 0; x < 30; x += 5) for (let z = 0; z < 30; z += 5) grove.push({ x: POND.x + x - 15, z: POND.z + z - 15 })
  const wet = make()
  wet.update(POND.x, 11, POND.z, dt, MIDNIGHT)
  const onWater = alive(wet).filter((b) => Math.hypot(b.homeX - POND.x, b.homeZ - POND.z) < POND.r)
  check(onWater.length === 0 && alive(wet).length > 0, 'none rolled over the pond', `${onWater.length} wet of ${alive(wet).length}`)
  wet.dispose()
  grove.length = grove.findIndex((p) => p.x >= cx - 30)
}
{
  // The trees land late: the tiles roll first, the trunks arrive, and the rescan admits the swarm.
  trees.grown = false
  const late = make()
  late.update(-10, 11, 0, dt, MIDNIGHT)
  const pending = late.stats.pending
  check(alive(late).length === 0 && pending > 0, 'a wood whose trees have not landed holds its candidates', `${pending} pending`)
  trees.grown = true
  for (let f = 0; f < 15 * late.tiles.size + 15; f++) late.update(-10, 11, 0, dt, MIDNIGHT)
  check(alive(late).length === alive(swarm).length, 'and admits them once the trunks are there', `${alive(late).length} of ${alive(swarm).length}`)
  late.dispose()
}

// --- flight and the flash ------------------------------------------------------
{
  const ids = alive(swarm).map((b) => b.id)
  const flashes = new Map(ids.map((id) => [id, { on: [], off: [], was: false, since: 0 }]))
  let low = 0, high = 0, far = 0, unwritten = 0, glowOff = 0, frames = 0, maxMs = 0, totalMs = 0
  let litMax = 0
  const onNow = []
  for (let f = 0; f < 72 * 90; f++) {
    const t0 = performance.now()
    swarm.update(-10, 11, 0, dt, MIDNIGHT)
    const ms = performance.now() - t0
    totalMs += ms
    if (ms > maxMs) maxMs = ms
    frames++
    let lit = 0
    const m = swarm.mesh.instanceMatrix.array, g = swarm.glow.array
    for (const b of alive(swarm)) {
      const ground = groundAt(b.x, b.z)
      // The ground under a firefly is read every few frames, so the floor trails the slope by a few millimetres.
      if (b.y < ground + FLY_M[0] - 0.02) low++
      if (b.y > ground + FLY_M[1] + 0.5) high++
      if (Math.hypot(b.x - b.homeX, b.z - b.homeZ) > TETHER + 3) far++
      if (b.on) lit++
      if (b.lit > litMax) litMax = b.lit
      const rec = flashes.get(b.id)
      rec.since += dt
      if (b.on !== rec.was) {
        (rec.was ? rec.on : rec.off).push(rec.since)
        rec.since = 0
        rec.was = b.on
      }
      let k = -1
      for (let i = 0; i < swarm.mesh.count; i++) if (Math.abs(m[i * 16 + 12] - b.x) < 1e-3 && Math.abs(m[i * 16 + 14] - b.z) < 1e-3) { k = i; break }
      if (k < 0) unwritten++
      else if (Math.abs(g[k] - b.lit) > 1e-6) glowOff++
    }
    onNow.push(lit)
  }
  const n = alive(swarm).length
  check(low === 0, 'never under FLY_M[0] over the ground', `${low} frames`)
  check(high === 0, 'never over FLY_M[1] over the ground', `${high} frames`)
  check(far === 0, 'never past the tether', `${far} frames`)
  check(unwritten === 0 && glowOff === 0, 'every firefly written with its own glow every frame', `${unwritten} unwritten, ${glowOff} wrong glow`)
  // Each firefly's first dark spell was partial: it was rolled part way through it.
  const ons = [...flashes.values()].flatMap((r) => r.on), offs = [...flashes.values()].flatMap((r) => r.off.slice(1))
  const within = (list, [lo, hi]) => list.every((s) => s >= lo - 4 * dt && s <= hi + 4 * dt)
  check(ons.length > n * 5 && within(ons, ON_S), 'each flash lasts ON_S', `${ons.length} flashes, ${Math.min(...ons).toFixed(2)}..${Math.max(...ons).toFixed(2)} s`)
  check(offs.length > n * 5 && within(offs, OFF_S), 'each dark spell lasts OFF_S', `${Math.min(...offs).toFixed(2)}..${Math.max(...offs).toFixed(2)} s`)
  const distinct = new Set(ons.map((s) => s.toFixed(2))).size
  check(distinct > 20, 'the flash length is re-rolled every time', `${distinct} distinct`)
  check(litMax > 0.99 && Math.max(...onNow) < n * 0.5, 'a flash reaches full glow and the swarm never flashes in step', `peak lit ${litMax.toFixed(3)}, at most ${Math.max(...onNow)} of ${n} on at once`)
  check(maxMs < 6 && totalMs / frames < 0.5, `a frame of ${n} costs under half a millisecond`, `mean ${(totalMs / frames).toFixed(3)} ms, max ${maxMs.toFixed(2)} ms`)
}

// --- the tiles follow her ---------------------------------------------------------
{
  swarm.update(-60, 11, 0, dt, MIDNIGHT)
  check(alive(swarm).every((b) => Math.hypot(b.homeX + 60, b.homeZ) < RADIUS + TILE) && swarm.tiles.size > 0, 'a walk west drops the tiles she left and grows the ones she reached')
  swarm.dispose()
  check(swarm.batch.parent === null, 'dispose takes the batch out of the scene')
}

console.log(failures ? `\n${failures} failure(s)` : '\nall firefly checks passed')
process.exit(failures ? 1 : 0)
