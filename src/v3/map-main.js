import { WORLD_SIZE, SEED } from '../v2/config.js'
import { clamp } from '../sim/mathx.js'
import { LAYERS, derive, paintInto } from './paint.js'
import { load, optionsFromUrl } from './store.js'
import { MACRO } from './island.js'

// ---------------------------------------------------------------------------
// /terrain-v3-map -- the 2D eye on the generated island (§31).
//
// A reader, like /map: it draws what the generator returned and never computes a field of its own (the painters in paint.js are the one place presentation lives). Every press of `generate` runs the worker, because this is the page the algorithm is iterated on, and what it makes is written to the cache /terrain-v3 boots from.
// ---------------------------------------------------------------------------

const canvas = document.getElementById('map')
const ctx = canvas.getContext('2d')
const elLog = document.getElementById('log')
const elStats = document.getElementById('stats')
const elReadout = document.getElementById('readout')
const elSeed = document.getElementById('seed')
const elRun = document.getElementById('run')

let R = null
let off = null
let layer = 'relief'
const view = { scale: 1, tx: 0, ty: 0 }
let hover = null

// --- render ----------------------------------------------------------------

function buildLayer() {
  if (!R) return
  const { n } = R
  if (!off || off.width !== n) {
    off = document.createElement('canvas')
    off.width = n
    off.height = n
  }
  const octx = off.getContext('2d')
  const img = octx.createImageData(n, n)
  paintInto(img.data, R, layer)
  octx.putImageData(img, 0, 0)
  draw()
}

function draw() {
  const W = canvas.width
  const H = canvas.height
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#05080f'
  ctx.fillRect(0, 0, W, H)
  if (!off) return
  // Nearest-neighbour once a texel is bigger than a pixel: smoothing invents texels that do not exist.
  ctx.imageSmoothingEnabled = view.scale < 1
  ctx.setTransform(view.scale, 0, 0, view.scale, view.tx, view.ty)
  ctx.drawImage(off, 0, 0)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  drawMarks()
  drawScaleBar()
}

function toScreen(i, j) {
  return [i * view.scale + view.tx, j * view.scale + view.ty]
}

function drawMarks() {
  const { cell, n, stats } = R
  const half = ((n - 1) * cell) / 2
  const mark = (x, z, colour, label) => {
    const [sx, sy] = toScreen((x + half) / cell + 0.5, (z + half) / cell + 0.5)
    ctx.strokeStyle = colour
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(sx - 7, sy)
    ctx.lineTo(sx + 7, sy)
    ctx.moveTo(sx, sy - 7)
    ctx.lineTo(sx, sy + 7)
    ctx.stroke()
    ctx.fillStyle = colour
    ctx.font = '11px monospace'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, sx + 9, sy)
  }
  mark(stats.summit.x, stats.summit.z, '#ff9bd2', `summit ${stats.summit.h.toFixed(0)} m`)
  // The mean coast, so the warp's ins and outs can be read against the circle they started from.
  const [cx, cy] = toScreen(half / cell + 0.5, half / cell + 0.5)
  ctx.strokeStyle = 'rgba(255,255,255,.18)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(cx, cy, (MACRO.coastRadius / cell) * view.scale, 0, Math.PI * 2)
  ctx.stroke()
}

function drawScaleBar() {
  const mpp = R.cell / view.scale
  const target = 140 * mpp
  const pow = Math.pow(10, Math.floor(Math.log10(target)))
  const step = [1, 2, 5, 10].find((s) => s * pow >= target) * pow
  const w = step / mpp
  const x = canvas.width - w - 20
  const y = canvas.height - 24
  ctx.strokeStyle = '#cfe3ff'
  ctx.fillStyle = '#cfe3ff'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x, y - 5)
  ctx.lineTo(x, y)
  ctx.lineTo(x + w, y)
  ctx.lineTo(x + w, y - 5)
  ctx.stroke()
  ctx.font = '11px monospace'
  ctx.textAlign = 'center'
  ctx.fillText(step >= 1000 ? `${step / 1000} km` : `${step} m`, x + w / 2, y - 12)
  ctx.textAlign = 'left'
}

// --- stats -----------------------------------------------------------------

function showStats() {
  const s = R.stats
  const relief = s.relief.map((r) => `${String(r.radius).padStart(5)} m  ${r.rms.toFixed(1).padStart(6)} m`).join('\n')
  const bowls = s.bowls.bodies.map((b) => `${String(Math.round(b.x)).padStart(6)},${String(Math.round(b.z)).padStart(6)}  ${b.km2.toFixed(3)} km2  ${b.deepest.toFixed(0).padStart(3)} m deep at ${b.level.toFixed(0)} m`).join('\n')
  elStats.innerHTML = `<h2>world</h2>seed ${R.seed}   ${R.n}^2 @ ${R.cell.toFixed(1)} m   algorithm ${R.v}
${(WORLD_SIZE / 1000).toFixed(2)} km across   ${R.ms.toFixed(0)} ms
elevation ${s.min.toFixed(0)} .. ${s.max.toFixed(0)} m

<h2>step A -- macro shape</h2>land      ${(s.landFraction * 100).toFixed(1)}%  (${s.landKm2.toFixed(1)} km2)
summit    ${s.summit.h.toFixed(0)} m, ${s.summit.offset.toFixed(0)} m off centre
coast     ${s.coast.lengthKm.toFixed(1)} km, x${s.coast.irregularity.toFixed(2)} its circle
sea floor ${s.seaFloor.offshore1km.toFixed(0)} m at 1 km out, ${s.seaFloor.boxEdge.toFixed(0)} m at the edge
snow line ${R.doc.snow.base.toFixed(0)} m

<h2>relief removed by a box blur</h2>${relief}

<h2>closed bowls (${s.bowls.count}, ${s.bowls.km2.toFixed(2)} km2)</h2>${bowls || 'none'}`
}

function showHover() {
  if (!R || !hover) {
    elReadout.textContent = 'hover the map'
    return
  }
  const { i, j } = hover
  const c = j * R.n + i
  const half = ((R.n - 1) * R.cell) / 2
  const x = i * R.cell - half
  const z = j * R.cell - half
  const h = R.height[c]
  const deg = (R._slope[c] * 180) / Math.PI
  elReadout.textContent =
    `texel ${i},${j}   world ${x.toFixed(0)}, ${z.toFixed(0)} m\n` +
    `elev  ${h.toFixed(1)} m   ${h <= 0 ? 'sea' : 'land'}\n` +
    `slope ${deg.toFixed(1)} deg${deg > 38 ? '  IMPASSABLE' : ''}\n` +
    `from centre ${Math.hypot(x, z).toFixed(0)} m`
}

// --- run -------------------------------------------------------------------

async function run() {
  const seed = Number(elSeed.value) | 0
  elRun.disabled = true
  elLog.textContent = ''
  elStats.textContent = 'generating...'
  history.replaceState(null, '', `?seed=${seed}`)
  try {
    const { result } = await load({ seed, regen: true, log: (line) => { elLog.textContent += `${line}\n` } })
    R = derive(result)
    fit()
    buildLayer()
    showStats()
  } catch (err) {
    console.error(err)
    elLog.innerHTML += `<span class="bad">${err.message}</span>\n`
    elStats.innerHTML = `<span class="bad">the generator threw:\n${err.message}</span>`
  } finally {
    elRun.disabled = false
  }
}

// --- view ------------------------------------------------------------------

function fit() {
  if (!R) return
  view.scale = Math.min(canvas.width, canvas.height) / R.n
  view.tx = (canvas.width - R.n * view.scale) / 2
  view.ty = (canvas.height - R.n * view.scale) / 2
}

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = Math.round(window.innerWidth * dpr)
  canvas.height = Math.round(window.innerHeight * dpr)
  canvas.style.width = `${window.innerWidth}px`
  canvas.style.height = `${window.innerHeight}px`
  fit()
  draw()
}
window.addEventListener('resize', resize)

canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  if (!R) return
  const dpr = canvas.width / canvas.clientWidth
  const mx = e.clientX * dpr
  const my = e.clientY * dpr
  const k = Math.exp(-e.deltaY * 0.0016)
  const next = clamp(view.scale * k, Math.min(canvas.width, canvas.height) / R.n / 4, 24)
  view.tx = mx - ((mx - view.tx) * next) / view.scale
  view.ty = my - ((my - view.ty) * next) / view.scale
  view.scale = next
  draw()
}, { passive: false })

let drag = null
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }
  canvas.setPointerCapture(e.pointerId)
})
canvas.addEventListener('pointerup', () => { drag = null })
canvas.addEventListener('pointermove', (e) => {
  const dpr = canvas.width / canvas.clientWidth
  if (drag) {
    view.tx = drag.tx + (e.clientX - drag.x) * dpr
    view.ty = drag.ty + (e.clientY - drag.y) * dpr
    draw()
  }
  if (!R) return
  const i = Math.floor((e.clientX * dpr - view.tx) / view.scale)
  const j = Math.floor((e.clientY * dpr - view.ty) / view.scale)
  hover = i >= 0 && j >= 0 && i < R.n && j < R.n ? { i, j } : null
  showHover()
})

// --- controls ---------------------------------------------------------------

const elLayers = document.getElementById('layers')
LAYERS.forEach(([id, label], k) => {
  const l = document.createElement('label')
  l.className = 'layer'
  l.innerHTML = `<input type="radio" name="layer" value="${id}"${id === layer ? ' checked' : ''}>${label}<span class="key">${k + 1}</span>`
  l.querySelector('input').addEventListener('change', () => {
    layer = id
    buildLayer()
  })
  elLayers.appendChild(l)
})

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return
  const k = Number(e.key)
  if (k >= 1 && k <= LAYERS.length) {
    layer = LAYERS[k - 1][0]
    elLayers.querySelector(`input[value="${layer}"]`).checked = true
    buildLayer()
  }
  if (e.key === 'f') {
    fit()
    draw()
  }
  if (e.key === 'Enter') run()
})

elRun.addEventListener('click', run)
elSeed.addEventListener('keydown', (e) => { if (e.key === 'Enter') run() })

const opts = optionsFromUrl(SEED)
elSeed.value = opts.seed
resize()
run()
