// The water surfaces (§11), checked against the ground they claim to sit on.
//
// Water.setFromPhaseA rests on one load-bearing claim: a level computed on the
// sim grid is the same level on the rendered terrain, because Phase A's `base`
// is sampled from the same heightAt the chunk mesher calls. If that ever stops
// being true, lakes float or sink, and it fails silently and beautifully -- the
// water still renders, just in the wrong place. So it is checked here directly,
// against heightAt rather than against the grid the lakes were computed on.
import * as THREE from 'three'
import { runPhaseA } from '../src/sim/phase-a.js'
import { Water } from '../src/water.js'
import { Sky } from '../src/sky.js'
import { WorldLighting } from '../src/lighting.js'
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
const scene = new THREE.Scene()
const water = new Water(scene, { sky: new Sky(scene), lighting: new WorldLighting() })
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

// --- nothing grows underwater ------------------------------------------------
//
// levelAt is what the scatter's exclusion predicate calls, so it is checked
// against the same mask the water is drawn from rather than re-derived.
let wrong = 0
let dry = 0
for (let j = 0; j < r.n; j += 3) {
  for (let i = 0; i < r.n; i += 3) {
    const c = j * r.n + i
    const x = -WORLD_HALF + (i + 0.5) * r.cell
    const z = -WORLD_HALF + (j + 0.5) * r.cell
    const lv = water.levelAt(x, z)
    const submerged = r.lake[c] === 1 && r.base[c] < r.filled[c]
    if (submerged && lv === null) wrong++
    if (!submerged && lv !== null) wrong++
    if (lv === null) dry++
  }
}
check(wrong === 0, 'levelAt reports water exactly where there is water', `${wrong} disagreements`)
check(dry > 0, 'levelAt reports dry land as dry', `${dry} dry samples`)
const lakeCell = [...Array(r.n * r.n).keys()].find((c) => r.lake[c] && r.base[c] < r.filled[c])
const lx = -WORLD_HALF + ((lakeCell % r.n) + 0.5) * r.cell
const lz = -WORLD_HALF + (((lakeCell / r.n) | 0) + 0.5) * r.cell
check(
  th.heightAt(lx, lz) < water.levelAt(lx, lz),
  'a prop standing mid-lake would be rejected as underwater',
  `ground ${th.heightAt(lx, lz).toFixed(1)} m, water ${water.levelAt(lx, lz).toFixed(1)} m`
)

// ...and the scatter has to actually ask. levelAt being right proves nothing
// about placement: the predicate is composed in main.js and installed once, and
// a scatter that never calls it, or calls it with the wrong argument order,
// still passes every check above. So drive the real Scatter standing in open
// water and read the matrices it wrote.
{
  const { Scatter } = await import('../src/props/scatter.js')

  // Stand at the deepest water in the world, not at the biggest lake's
  // centroid: these basins are dendritic, and the centroid of the largest one
  // sits 88 m up a spur of dry land between two arms of it. A site with no
  // water under it makes the control below vacuous.
  let deepest = -1
  let deepestBy = 0
  for (let c = 0; c < r.n * r.n; c++) {
    if (!r.lake[c]) continue
    const d = r.filled[c] - r.base[c]
    if (d > deepestBy) { deepestBy = d; deepest = c }
  }
  const site = {
    x: -WORLD_HALF + ((deepest % r.n) + 0.5) * r.cell,
    z: -WORLD_HALF + (((deepest / r.n) | 0) + 0.5) * r.cell,
  }

  const drowned = (props) => {
    const m = new THREE.Matrix4()
    let n = 0
    let worstSink = 0
    for (const s of props.kinds) {
      for (let k = 0; k < s.count; k++) {
        props.batch.getMatrixAt(s.instances[k], m)
        const x = m.elements[12]
        const z = m.elements[14]
        const lv = water.levelAt(x, z)
        if (lv === null) continue
        const d = lv - th.heightAt(x, z)
        if (d <= 0) continue
        n++
        if (d > worstSink) worstSink = d
      }
    }
    return { n, worstSink }
  }

  // One kind rebuilds per update() by design, so settling takes as many calls
  // as there are kinds -- the same dance check-terrain.mjs does.
  const settle = (props) => {
    for (let i = 0; i < props.kinds.length + 2; i++) props.update(site.x, site.z)
  }

  // The control. If nothing would have drowned here anyway, the check below is
  // green for the wrong reason and would stay green with the predicate deleted.
  const bare = new Scatter(new THREE.Scene(), th, { seed: SEED })
  settle(bare)
  const would = drowned(bare)
  check(would.n > 0, 'open water would drown props if nothing stopped it',
    `${would.n} props under water, worst ${would.worstSink.toFixed(1)} m down`)

  // The same predicate main.js composes, minus villages (checked in its own file).
  const guarded = new Scatter(new THREE.Scene(), th, { seed: SEED })
  guarded.setExclusion((x, z) => {
    const level = water.levelAt(x, z)
    return level !== null && th.heightAt(x, z) < level
  })
  settle(guarded)
  const got = drowned(guarded)
  check(got.n === 0, 'the scatter places nothing underwater',
    got.n ? `${got.n} still submerged, worst ${got.worstSink.toFixed(1)} m down`
          : `${would.n} would have drowned, 0 placed under water`)
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
