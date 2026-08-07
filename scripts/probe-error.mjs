// How much does a node's mesh actually deviate from the true height field?
//
//   node scripts/probe-error.mjs [seed]
//
// This is the measurement that decides whether an error-driven split rule is
// worth building at all. The proposed rule is
//
//   split if  max(delta, cell * FLOOR)  >  range * tan(tau)
//
// where `delta` is the node's geometric error in metres and `cell` is its grid
// spacing (size / CHUNK_RES). The floor term alone reproduces today's uniform
// angular-triangle rule. So delta only CHANGES anything where delta > cell --
// where the field's vertical deviation inside one cell exceeds that cell's own
// width. If that never happens, the error term is dead weight and the honest
// answer is to ship the plain distance rule and stop.
//
// It also asks whether mean elevation -- what the deleted ELEV_LOD bias keyed on
// -- was ever a usable proxy for delta.

import { TerrainHeight, WORLD_HALF, WORLD_SIZE } from '../src/sim/terrain-height.js'
import { CHUNK_RES } from '../src/sim/chunk-mesh.js'

const SEED = Number(process.argv[2] ?? 20260804)
const th = new TerrainHeight(SEED)

let rs = 4242
const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

const pct = (a, p) => {
  const s = Float64Array.from(a).sort()
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

// Geometric error of one node: sample the node's own mesh grid, then compare
// bilinear interpolation of that grid against the true field at interior points.
// This is exactly what the renderer's triangles get wrong, up to the diagonal
// choice, which is a sub-cell detail and not what sets the magnitude.
function nodeError(ox, oz, size, samples = 500) {
  const res = CHUNK_RES
  const step = size / res
  const vpr = res + 1
  const G = new Float64Array(vpr * vpr)
  for (let j = 0; j < vpr; j++) {
    for (let i = 0; i < vpr; i++) G[j * vpr + i] = th.heightAt(ox + i * step, oz + j * step)
  }

  let maxErr = 0
  let sumSq = 0
  for (let s = 0; s < samples; s++) {
    const u = rnd() * res
    const v = rnd() * res
    const i = Math.min(res - 1, Math.floor(u))
    const j = Math.min(res - 1, Math.floor(v))
    const fu = u - i
    const fv = v - j
    const h00 = G[j * vpr + i]
    const h10 = G[j * vpr + i + 1]
    const h01 = G[(j + 1) * vpr + i]
    const h11 = G[(j + 1) * vpr + i + 1]
    const lerped = h00 * (1 - fu) * (1 - fv) + h10 * fu * (1 - fv) + h01 * (1 - fu) * fv + h11 * fu * fv
    const truth = th.heightAt(ox + u * step, oz + v * step)
    const e = Math.abs(truth - lerped)
    if (e > maxErr) maxErr = e
    sumSq += e * e
  }
  // Mean elevation of the node, for the correlation question below.
  let mean = 0
  for (let k = 0; k < G.length; k++) mean += G[k]
  return { maxErr, rms: Math.sqrt(sumSq / samples), mean: mean / G.length }
}

console.log(`\n=== node geometric error, seed ${SEED}, CHUNK_RES ${CHUNK_RES} ===\n`)
console.log(
  `  ${'depth'.padStart(5)} ${'size'.padStart(6)} ${'cell'.padStart(7)}  ` +
    `${'err p50'.padStart(8)} ${'err p90'.padStart(8)} ${'err max'.padStart(8)}  ` +
    `${'err/cell p50'.padStart(12)} ${'p90'.padStart(6)} ${'max'.padStart(6)}   ${'corr(err,elev)'.padStart(14)}`
)

const N_NODES = 180
for (let depth = 2; depth <= 9; depth++) {
  const size = WORLD_SIZE / (1 << depth)
  const cell = size / CHUNK_RES
  const errs = []
  const ratios = []
  const means = []
  for (let n = 0; n < N_NODES; n++) {
    const ix = Math.floor(rnd() * (1 << depth))
    const iz = Math.floor(rnd() * (1 << depth))
    const r = nodeError(-WORLD_HALF + ix * size, -WORLD_HALF + iz * size, size)
    errs.push(r.maxErr)
    ratios.push(r.maxErr / cell)
    means.push(r.mean)
  }
  // Pearson correlation between node error and node mean elevation -- the
  // question the deleted bias implicitly answered "yes" to.
  const mE = errs.reduce((s, v) => s + v, 0) / errs.length
  const mM = means.reduce((s, v) => s + v, 0) / means.length
  let cov = 0
  let vE = 0
  let vM = 0
  for (let i = 0; i < errs.length; i++) {
    cov += (errs[i] - mE) * (means[i] - mM)
    vE += (errs[i] - mE) ** 2
    vM += (means[i] - mM) ** 2
  }
  const corr = cov / Math.sqrt(vE * vM)

  console.log(
    `  ${String(depth).padStart(5)} ${size.toFixed(0).padStart(6)} ${cell.toFixed(2).padStart(7)}  ` +
      `${pct(errs, 0.5).toFixed(2).padStart(8)} ${pct(errs, 0.9).toFixed(2).padStart(8)} ${Math.max(...errs).toFixed(2).padStart(8)}  ` +
      `${pct(ratios, 0.5).toFixed(3).padStart(12)} ${pct(ratios, 0.9).toFixed(3).padStart(6)} ${Math.max(...ratios).toFixed(3).padStart(6)}   ` +
      `${corr.toFixed(2).padStart(14)}`
  )
}

console.log(
  '\n  err/cell > 1 is where the error term refines FURTHER than the uniform angular rule.\n' +
    '  err/cell << 1 means the uniform rule is already conservative and the error term\n' +
    '  can only be used to COARSEN flat ground, not to sharpen peaks.\n'
)
