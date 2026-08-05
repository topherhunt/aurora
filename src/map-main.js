import { WORLD_SIZE } from './sim/terrain-height.js'
import { BIOME_NAMES, VILLAGE, streamWidth } from './sim/phase-a.js'
import { clamp } from './sim/mathx.js'
import { LAYERS, BIOME_RGB, derive, paintInto, slopeAt } from './map-layers.js'

// ---------------------------------------------------------------------------
// The Phase A map view (§14 step 3).
//
// Everything here is a READER. It does not tune, decide or cache anything --
// phase-a.js owns every constant and this module only draws what that pass
// returned. That separation is deliberate: the moment the debug view computes
// its own version of a field, it stops being an instrument and becomes a twelfth
// entry on §14's list of instruments that disagreed with the thing they measured.
//
// The one exception is hillshade, which is presentation and exists nowhere else.
//
// The layers themselves live in map-layers.js, DOM-free, so that this page and
// scripts/phase-a-png.mjs render from one implementation rather than two.
// ---------------------------------------------------------------------------

const canvas = document.getElementById('map')
const ctx = canvas.getContext('2d')
const elLog = document.getElementById('log')
const elStats = document.getElementById('stats')
const elReadout = document.getElementById('readout')
const elSeed = document.getElementById('seed')
const elRes = document.getElementById('res')
const elRun = document.getElementById('run')

let R = null // the Phase A result
let off = null // n x n offscreen canvas holding the current layer
let layer = 'relief'
const overlay = { water: true, marks: true, contour: false, unreach: false }
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
  paintInto(img.data, R, layer, overlay)
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

  // Nearest-neighbour once a cell is bigger than a pixel: this is a data view,
  // and smoothing invents cells that do not exist.
  ctx.imageSmoothingEnabled = view.scale < 1
  ctx.setTransform(view.scale, 0, 0, view.scale, view.tx, view.ty)
  ctx.drawImage(off, 0, 0)
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  if (overlay.marks) drawMarks()
  drawScaleBar()
}

function toScreen(i, j) {
  return [i * view.scale + view.tx, j * view.scale + view.ty]
}

function drawMarks() {
  ctx.lineWidth = 1.5
  ctx.font = '11px monospace'
  ctx.textBaseline = 'middle'

  R.villages.forEach((v, k) => {
    const [sx, sy] = toScreen(v.i + 0.5, v.j + 0.5)
    ctx.strokeStyle = '#0b1220'
    ctx.fillStyle = '#ffd07a'
    ctx.beginPath()
    ctx.arc(sx, sy, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    // The separation constraint is a distance in metres and therefore a circle
    // on this map. Drawing it is the fastest way to see whether VILLAGE.count is
    // capped by merit or merely by packing.
    ctx.strokeStyle = 'rgba(255,208,122,.22)'
    ctx.beginPath()
    ctx.arc(sx, sy, (VILLAGE.minSeparation / R.cell) * view.scale, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = '#ffd07a'
    ctx.fillText(`v${k + 1} ${v.score.toFixed(2)}`, sx + 8, sy)
  })

  mark(R.spawn.i, R.spawn.j, '#7dffa8', 'spawn')
  mark(R.summit.i, R.summit.j, '#ff9bd2', `summit ${R.summit.h.toFixed(0)}m`)
}

function mark(i, j, colour, label) {
  const [sx, sy] = toScreen(i + 0.5, j + 0.5)
  ctx.strokeStyle = colour
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(sx - 7, sy)
  ctx.lineTo(sx + 7, sy)
  ctx.moveTo(sx, sy - 7)
  ctx.lineTo(sx, sy + 7)
  ctx.stroke()
  ctx.fillStyle = colour
  ctx.fillText(label, sx + 9, sy)
}

function drawScaleBar() {
  // Metres per screen pixel, rounded to a 1/2/5 step.
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
  ctx.textAlign = 'center'
  ctx.fillText(step >= 1000 ? `${step / 1000} km` : `${step} m`, x + w / 2, y - 12)
  ctx.textAlign = 'left'
}

// --- stats -----------------------------------------------------------------

function showStats() {
  const r = R
  const size = r.n * r.n
  const km2 = (cells) => ((cells * r.cell * r.cell) / 1e6).toFixed(2)
  const pct = (cells) => ((cells / size) * 100).toFixed(1)

  const biomeRows = BIOME_NAMES.map(
    (nm, k) =>
      `<span class="sw" style="background:rgb(${BIOME_RGB[k].join(',')})"></span>${nm.padEnd(6)} ${pct(r.biomeArea[k]).padStart(5)}%`,
  ).join('\n')

  let lakeCells = 0
  for (let c = 0; c < size; c++) lakeCells += r.lake[c]

  const trunk = r.acc.reduce((a, b) => (b > a ? b : a), 0)
  const reach = (r.reachableFraction * 100).toFixed(1)
  const reachClass = r.reachableFraction < 0.9 ? 'warn' : ''

  elStats.innerHTML = `<h2>world</h2>seed ${r.seed}   ${r.n}^2 @ ${r.cell.toFixed(2)} m
${(WORLD_SIZE / 1000).toFixed(2)} km across   ${r.ms.toFixed(0)} ms
elevation ${r._lo.toFixed(0)} - ${r._hi.toFixed(0)} m

<h2>breach (§2 step 4)</h2>${r.breach.passes} passes, ${r.breach.breached} channels
deepest cut ${r.breach.deepestCut.toFixed(0)} m   refused ${r.breach.refused}

<h2>water</h2>lakes    ${r.lakes.length} bodies, ${km2(lakeCells)} km^2 (${pct(lakeCells)}%)
streams  ${r.streamCells} cells (${pct(r.streamCells)}%)
trunk    ${trunk} cells -> ${streamWidth(trunk, r._minAcc).toFixed(1)} m wide
minAcc   ${r._minAcc.toFixed(0)} cells = ${km2(r._minAcc)} km^2

<h2>biomes</h2>${biomeRows}

<h2>villages</h2>${r.villages.map((v, k) => `v${k + 1} ${String(Math.round(v.x)).padStart(6)},${String(Math.round(v.z)).padStart(6)} ${v.h.toFixed(0).padStart(4)}m  ${v.score.toFixed(3)}`).join('\n')}

<h2>connectivity</h2><span class="${reachClass}">${reach}% reachable from spawn</span>
${r.unreachable.length === 0 ? 'all villages + summit reachable' : `<span class="bad">UNREACHABLE: ${r.unreachable.map((u) => u.kind).join(', ')}</span>`}`
}

function showHover() {
  if (!R || !hover) {
    elReadout.textContent = 'hover the map'
    return
  }
  const { i, j } = hover
  const r = R
  const c = j * r.n + i
  const x = -WORLD_SIZE / 2 + (i + 0.5) * r.cell
  const z = -WORLD_SIZE / 2 + (j + 0.5) * r.cell
  const sl = (slopeAt(r.elev, i, j, r.n, r.cell) * 180) / Math.PI
  const cut = r.base[c] - r.elev[c]
  const pond = r.filled[c] - r.elev[c]
  const kind = r.lake[c] ? 'lake' : r.stream[c] ? 'stream' : 'land'
  elReadout.textContent =
    `cell ${i},${j}   world ${x.toFixed(0)}, ${z.toFixed(0)} m\n` +
    `elev  ${r.elev[c].toFixed(1)} m   snowline ${r.snowLine[c].toFixed(0)} m  (${(r.elev[c] - r.snowLine[c]).toFixed(0)} rel)\n` +
    `slope ${sl.toFixed(1)} deg ${sl > 38 ? '  IMPASSABLE' : ''}\n` +
    `cut   ${cut.toFixed(2)} m   ponded ${pond.toFixed(2)} m\n` +
    `acc   ${r.acc[c]} cells   ${kind}\n` +
    `moist ${r.moisture[c].toFixed(3)}   biome ${BIOME_NAMES[r.biome[c]]}\n` +
    `reachable from spawn: ${r.reachable[c] ? 'yes' : 'NO'}`
}

// --- run -------------------------------------------------------------------

let worker = null

function run() {
  const seed = Number(elSeed.value) | 0
  const n = Number(elRes.value)
  elRun.disabled = true
  elLog.textContent = `running ${n}^2...\n`
  elStats.textContent = 'running...'

  if (worker) worker.terminate()
  worker = new Worker(new URL('./sim/phase-a-worker.js', import.meta.url), { type: 'module' })
  worker.onmessage = (e) => {
    const m = e.data
    if (m.type === 'log') {
      elLog.textContent += `${m.line}\n`
      return
    }
    if (m.type === 'error') {
      elRun.disabled = false
      elLog.innerHTML += `<span class="bad">${m.message}</span>\n`
      elStats.innerHTML = `<span class="bad">Phase A threw:\n${m.message}</span>`
      console.error(m.stack)
      return
    }
    R = derive(m.result)
    elRun.disabled = false
    elLog.textContent += `total ${R.ms.toFixed(0)} ms\n`
    fit()
    buildLayer()
    showStats()
  }
  worker.postMessage({ seed, n })
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

canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  if (!R) return
  const dpr = canvas.width / canvas.clientWidth
  const mx = e.clientX * dpr
  const my = e.clientY * dpr
  const k = Math.exp(-e.deltaY * 0.0016)
  const next = clamp(view.scale * k, Math.min(canvas.width, canvas.height) / R.n / 4, 24)
  // Zoom about the cursor: the cell under the pointer must not move.
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
canvas.addEventListener('pointerup', () => {
  drag = null
})
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

const OVERLAYS = [
  ['water', 'streams + lakes', 'w'],
  ['marks', 'villages / spawn', 'v'],
  ['contour', 'contours (25 m)', 'c'],
  ['unreach', 'unreachable ground', 'u'],
]
const elOverlays = document.getElementById('overlays')
OVERLAYS.forEach(([id, label, key]) => {
  const l = document.createElement('label')
  l.className = 'layer'
  l.innerHTML = `<input type="checkbox" value="${id}"${overlay[id] ? ' checked' : ''}>${label}<span class="key">${key}</span>`
  l.querySelector('input').addEventListener('change', (e) => {
    overlay[id] = e.target.checked
    buildLayer()
  })
  elOverlays.appendChild(l)
})

function setOverlay(id, on) {
  overlay[id] = on
  elOverlays.querySelector(`input[value="${id}"]`).checked = on
  buildLayer()
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return
  const k = Number(e.key)
  if (k >= 1 && k <= LAYERS.length) {
    layer = LAYERS[k - 1][0]
    elLayers.querySelector(`input[value="${layer}"]`).checked = true
    buildLayer()
    return
  }
  const ov = OVERLAYS.find((o) => o[2] === e.key)
  if (ov) setOverlay(ov[0], !overlay[ov[0]])
  else if (e.key === 'f') {
    fit()
    draw()
  } else if (e.key === 'r') run()
})

elRun.addEventListener('click', run)
window.addEventListener('resize', resize)
resize()
run()
