// The water surfaces (§11), checked against the ground they claim to sit on.
//
// Water.setFromPhaseA rests on one load-bearing claim: a level computed on the
// sim grid is the same level on the rendered terrain, because Phase A's `base`
// is sampled from the same heightAt the chunk mesher calls. If that ever stops
// being true, lakes float or sink, and it fails silently and beautifully -- the
// water still renders, just in the wrong place. So it is checked here directly,
// against heightAt rather than against the grid the lakes were computed on.
import * as THREE from 'three'
import { runPhaseA, STREAM, streamWidth } from '../src/sim/phase-a.js'
import { Water } from '../src/water.js'
import { TerrainHeight, WORLD_SIZE, WORLD_HALF } from '../src/sim/terrain-height.js'

let failures = 0
function check(ok, title, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? ' ok  ' : ' FAIL'} ${title}${detail ? `   ${detail}` : ''}`)
}

const SEED = 20260804
const N = 512
const r = runPhaseA(SEED, N)
const th = new TerrainHeight(SEED)
const water = new Water(new THREE.Scene())
const built = water.setFromPhaseA({ lake: r.lake, filled: r.filled, ground: r.base, n: r.n, cell: r.cell })

console.log(`\nwater   seed ${SEED}, ${N}^2, cell ${r.cell.toFixed(1)} m`)
check(r.lakes.length > 0, 'Phase A produced lakes to draw', `${r.lakes.length} bodies`)
check(built.triangles > 0, 'the water mesh has geometry', `${built.triangles} triangles in ${built.tiles} tiles`)

// Merging runs must not lose or invent surface. Mask area + dilation ring is
// the upper bound; mask area alone the lower.
let maskCells = 0
for (let c = 0; c < r.n * r.n; c++) if (r.lake[c] && r.base[c] < r.filled[c]) maskCells++
let quadArea = 0
for (const mesh of water.lakes.children) {
  const p = mesh.geometry.getAttribute('position').array
  for (let q = 0; q < p.length / 12; q++) {
    const v = q * 12
    quadArea += (p[v + 3] - p[v]) * (p[v + 11] - p[v + 2])
  }
}
const maskArea = maskCells * r.cell * r.cell
check(quadArea >= maskArea * 0.99, 'the merged quads cover at least the lake mask', `${(quadArea / 1e6).toFixed(2)} vs ${(maskArea / 1e6).toFixed(2)} km^2`)
check(quadArea <= maskArea * 4, 'the dilation ring did not run away', `${(quadArea / maskArea).toFixed(2)}x the mask`)

// THE claim. Sample every lake cell's centre and ask the ANALYTIC height
// function -- the one the chunk mesher uses -- whether the ground there really
// is under water. A lake floor poking above its own surface means the sim grid
// and the render surface have drifted apart.
let above = 0
let worst = 0
let sampled = 0
for (let j = 0; j < r.n; j++) {
  for (let i = 0; i < r.n; i++) {
    const c = j * r.n + i
    if (!r.lake[c] || r.base[c] >= r.filled[c]) continue
    sampled++
    const x = -WORLD_HALF + (i + 0.5) * r.cell
    const z = -WORLD_HALF + (j + 0.5) * r.cell
    const h = th.heightAt(x, z)
    const d = h - r.filled[c]
    if (d > 0) {
      above++
      if (d > worst) worst = d
    }
  }
}
check(sampled > 0, 'there are lake cells to sample', `${sampled}`)
check(
  above === 0,
  'the rendered ground under every lake really is below its water level',
  above ? `${above}/${sampled} cells dry, worst ${worst.toFixed(2)} m proud` : `${sampled} cells, all submerged`
)

// Every quad must sit at a level some lake actually has. A quad at an
// interpolated or averaged height would be a surface no basin holds.
const levels = new Set(r.lakes.map((l) => l.level))
let offLevel = 0
for (const mesh of water.lakes.children) {
  const p = mesh.geometry.getAttribute('position').array
  for (let k = 1; k < p.length; k += 3) if (!levels.has(p[k])) offLevel++
}
check(offLevel === 0, 'every water vertex sits at a level some lake body holds', `${offLevel} stray vertices`)

// A lake you cannot walk to is scenery. She should be able to reach at least
// one shoreline from spawn.
const reach = r.reachable
let touching = 0
for (const l of r.lakes) {
  const c = l.j * r.n + l.i
  let near = false
  for (let dj = -3; dj <= 3 && !near; dj++)
    for (let di = -3; di <= 3; di++) {
      const d = c + dj * r.n + di
      if (d >= 0 && d < r.n * r.n && reach[d] === 1) { near = true; break }
    }
  if (near) touching++
}
check(touching > 0, 'at least one lake shore is reachable on foot from spawn', `${touching}/${r.lakes.length} bodies`)

// --- rivers ----------------------------------------------------------------
const riv = water.setStreamsFromPhaseA({
  stream: r.stream, recv: r.recv, acc: r.acc, lake: r.lake, n: r.n, cell: r.cell, th, minAcc: r.minAcc,
})
check(riv.chains > 0, 'the flow network turned into river chains', `${riv.chains} chains, ${riv.triangles} triangles`)

// minAcc is resolution-scaled inside runPhaseA and streamWidth defaults to the
// UNSCALED constant. A caller who forgets to pass it gets rivers at plausible
// but wrong widths and nothing complains -- at 1024^2 the scaled value is 625
// against a constant of 2500, so every river came out half as wide.
check(r.minAcc !== undefined, 'Phase A reports the scaled stream threshold', `minAcc ${r.minAcc} (constant is ${STREAM.minAcc})`)
const wide = streamWidth(Math.max(...[...r.acc].filter((_, i) => r.stream[i])), r.minAcc)
check(wide > STREAM.widthAtMin * 2, 'the trunk rivers are meaningfully wider than the headwaters', `widest ${wide.toFixed(1)} m vs ${STREAM.widthAtMin} m`)

// THE river claim: a ribbon smoothed in plan must still lie in the valley it
// drains. Smoothing a D8 path cuts corners, and a corner cut across a spur puts
// the river through a ridge -- visible as water disappearing into a hillside.
// Sample each segment midpoint and ask how far the real ground is above it.
let buried = 0
let segs = 0
let deepest = 0
for (const mesh of water.streams.children) {
  const p = mesh.geometry.getAttribute('position').array
  // Walk the INDEX buffer, not the vertex buffer. A tile concatenates several
  // chains into one attribute array, so consecutive vertices are not
  // necessarily a segment -- reading them in order invents a joining segment
  // between the tail of one river and the head of the next, which measured as
  // 1567 buried segments and a 208 m worst case that no real 16 m step could
  // produce. The index buffer contains only quads that exist.
  const ix = mesh.geometry.getIndex().array
  for (let q = 0; q < ix.length; q += 6) {
    const a = ix[q] * 3
    const b = ix[q + 2] * 3
    const mx = (p[a] + p[b]) / 2
    const mz = (p[a + 2] + p[b + 2]) / 2
    const my = (p[a + 1] + p[b + 1]) / 2
    segs++
    const d = th.heightAt(mx, mz) - my
    if (d > 2) {
      buried++
      if (d > deepest) deepest = d
    }
  }
}
check(segs > 0, 'there are river segments to sample', `${segs}`)
check(
  buried < segs * 0.02,
  'no river segment tunnels through the ground it runs over',
  `${buried}/${segs} segments buried, worst ${deepest.toFixed(1)} m`
)

// Every ribbon vertex, both banks, must sit ON the ground -- not floating over
// it and not sunk into it. This is the promise that makes a painted-on river
// look like water rather than a ramp, and it is the one that broke when the
// ribbon was held level across its width.
let off = 0
let worstOff = 0
let verts = 0
for (const mesh of water.streams.children) {
  const p = mesh.geometry.getAttribute('position').array
  for (let v = 0; v < p.length; v += 3) {
    verts++
    const d = Math.abs(p[v + 1] - th.heightAt(p[v], p[v + 2]))
    if (d > 1) off++
    if (d > worstOff) worstOff = d
  }
}
check(off === 0, 'both banks of every river sit on the ground', `${off}/${verts} vertices off, worst ${worstOff.toFixed(2)} m`)

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
