// The polygon tracer, served at /poly-trace.
//
// Drop an image, click a polygon around it, drag the points until they fit.
// Coordinates are IMAGE PIXELS with the origin at the image's top-left, and they
// are deliberately unclamped: a point placed off the edge reads negative or past
// width/height, which is what makes this usable for a hull that has to sit
// OUTSIDE the artwork (a collision shape, a card's cutout, a safe area).
//
// A second dropped image opens in its own tab rather than replacing the first.
// The File object crosses to the new tab by postMessage -- File is structured
// cloneable, so the bytes never touch a URL, a blob lifetime, or storage. The
// child announces itself with the one-shot token in its hash; the parent answers
// that token once and forgets it.

const canvas = document.getElementById('view')
const ctx = canvas.getContext('2d')
const stage = document.getElementById('stage')
const tip = document.getElementById('tip')
const hint = document.getElementById('hint')
const listEl = document.getElementById('list')
const statusEl = document.getElementById('status')

const POINT_R = 5 // screen px, drawn
const PICK_R = 9 // screen px, hit radius for a point
const SEG_R = 7 // screen px, hit radius for "insert into this edge"

const state = {
  img: null,
  name: '',
  pts: [], // image space, {x, y}
  scale: 1,
  tx: 0,
  ty: 0,
  hover: -1, // point index under the cursor
  seg: null, // {i, x, y} insert preview, image space
  drag: -1,
  grab: { x: 0, y: 0 }, // cursor-to-point offset at grab time, image space
  pan: null, // {sx, sy, tx, ty, moved}
}

// --- view transform ---------------------------------------------------------

const toScreenX = (x) => x * state.scale + state.tx
const toScreenY = (y) => y * state.scale + state.ty
const toImageX = (sx) => (sx - state.tx) / state.scale
const toImageY = (sy) => (sy - state.ty) / state.scale

function cursor(e) {
  const r = canvas.getBoundingClientRect()
  return { sx: e.clientX - r.left, sy: e.clientY - r.top }
}

function fit() {
  if (!state.img) return
  const w = stage.clientWidth
  const h = stage.clientHeight
  state.scale = Math.min(w / state.img.naturalWidth, h / state.img.naturalHeight) * 0.85
  state.tx = (w - state.img.naturalWidth * state.scale) / 2
  state.ty = (h - state.img.naturalHeight * state.scale) / 2
  draw()
}

// --- drawing ----------------------------------------------------------------

function draw() {
  const dpr = window.devicePixelRatio || 1
  const w = stage.clientWidth
  const h = stage.clientHeight
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  if (state.img) {
    const iw = state.img.naturalWidth * state.scale
    const ih = state.img.naturalHeight * state.scale
    // Nearest-neighbour once a texel is bigger than a few screen pixels: at that
    // zoom you are placing a point ON a specific texel and want to see its edge.
    ctx.imageSmoothingEnabled = state.scale < 3
    ctx.drawImage(state.img, state.tx, state.ty, iw, ih)
    ctx.strokeStyle = '#2b4a72'
    ctx.lineWidth = 1
    ctx.strokeRect(state.tx + 0.5, state.ty + 0.5, iw, ih)
  }

  const pts = state.pts
  if (pts.length > 1) {
    ctx.beginPath()
    ctx.moveTo(toScreenX(pts[0].x), toScreenY(pts[0].y))
    for (let i = 1; i < pts.length; i++) ctx.lineTo(toScreenX(pts[i].x), toScreenY(pts[i].y))
    ctx.closePath()
    if (pts.length > 2) {
      ctx.fillStyle = 'rgba(127,209,255,.14)'
      ctx.fill()
    }
    ctx.strokeStyle = '#7fd1ff'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  if (state.seg) {
    ctx.beginPath()
    ctx.arc(toScreenX(state.seg.x), toScreenY(state.seg.y), POINT_R - 1, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(127,209,255,.5)'
    ctx.fill()
  }

  ctx.font = '9px monospace'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < pts.length; i++) {
    const sx = toScreenX(pts[i].x)
    const sy = toScreenY(pts[i].y)
    const here = i === state.hover || i === state.drag
    ctx.beginPath()
    ctx.arc(sx, sy, here ? POINT_R + 2 : POINT_R, 0, Math.PI * 2)
    ctx.fillStyle = here ? '#eaf3ff' : '#0e1726'
    ctx.fill()
    ctx.strokeStyle = here ? '#eaf3ff' : '#7fd1ff'
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.fillStyle = here ? '#eaf3ff' : '#7f96b8'
    ctx.fillText(String(i), sx + POINT_R + 3, sy - POINT_R - 1)
  }
}

// --- hit testing ------------------------------------------------------------

function pickPoint(sx, sy) {
  let best = -1
  let bestD = PICK_R
  for (let i = 0; i < state.pts.length; i++) {
    const d = Math.hypot(sx - toScreenX(state.pts[i].x), sy - toScreenY(state.pts[i].y))
    if (d <= bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

// The polygon is closed, so the last edge (n-1 -> 0) is a real edge and gets an
// insert too -- without it there is no way to add a point between the last and
// first once the loop is drawn.
function pickSegment(sx, sy) {
  const pts = state.pts
  if (pts.length < 2) return null
  let best = null
  let bestD = SEG_R
  const last = pts.length > 2 ? pts.length : pts.length - 1
  for (let i = 0; i < last; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    const ax = toScreenX(a.x)
    const ay = toScreenY(a.y)
    const vx = toScreenX(b.x) - ax
    const vy = toScreenY(b.y) - ay
    const len2 = vx * vx + vy * vy
    const t = len2 ? Math.max(0, Math.min(1, ((sx - ax) * vx + (sy - ay) * vy) / len2)) : 0
    const cx = ax + t * vx
    const cy = ay + t * vy
    const d = Math.hypot(sx - cx, sy - cy)
    if (d <= bestD) {
      bestD = d
      best = { i, x: toImageX(cx), y: toImageY(cy) }
    }
  }
  return best
}

function showTip(i, sx, sy) {
  const p = state.pts[i]
  const u = p.x / state.img.naturalWidth
  const v = p.y / state.img.naturalHeight
  tip.textContent = `#${i}  x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}\n     u ${u.toFixed(4)}  v ${v.toFixed(4)}`
  tip.style.display = 'block'
  tip.style.left = `${sx + 14}px`
  tip.style.top = `${sy + 14}px`
}

// --- point edits ------------------------------------------------------------

function addPoint(x, y) {
  const seg = state.seg
  if (seg) state.pts.splice(seg.i + 1, 0, { x, y })
  else state.pts.push({ x, y })
  state.seg = null
  changed()
}

function removePoint(i) {
  state.pts.splice(i, 1)
  state.hover = -1
  state.seg = null
  tip.style.display = 'none'
  changed()
}

function changed() {
  renderList()
  draw()
}

function renderList() {
  if (!state.pts.length) {
    listEl.innerHTML = '<p class="note">No points yet. Click on the image -- or anywhere around it -- to drop the first one. Click an edge to insert between two points; right-click a point to delete it.</p>'
    return
  }
  const w = state.img.naturalWidth
  const h = state.img.naturalHeight
  const rows = state.pts.map((p, i) => {
    const out = p.x < 0 || p.y < 0 || p.x > w || p.y > h ? ' out' : ''
    const here = i === state.hover || i === state.drag ? ' here' : ''
    return `<tr class="${here}${out}" data-i="${i}">` +
      `<td class="i">${i}</td>` +
      `<td class="n">${p.x.toFixed(1)}</td>` +
      `<td class="n">${p.y.toFixed(1)}</td>` +
      `<td class="x" data-del="${i}">&times;</td></tr>`
  }).join('')
  listEl.innerHTML = `<h2>${state.pts.length} points</h2><table>${rows}</table>` +
    '<p class="note">Coordinates are image pixels from the top-left. Amber means the point sits outside the image bounds.</p>'
}

listEl.addEventListener('click', (e) => {
  const del = e.target.dataset?.del
  if (del !== undefined) removePoint(Number(del))
})
listEl.addEventListener('mouseover', (e) => {
  const row = e.target.closest?.('tr')
  if (!row) return
  state.hover = Number(row.dataset.i)
  changed()
})
listEl.addEventListener('mouseleave', () => {
  state.hover = -1
  changed()
})

// --- pointer ----------------------------------------------------------------

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !state.img) return
  canvas.setPointerCapture(e.pointerId)
  const { sx, sy } = cursor(e)
  const i = pickPoint(sx, sy)
  if (i >= 0) {
    state.drag = i
    state.grab = { x: state.pts[i].x - toImageX(sx), y: state.pts[i].y - toImageY(sy) }
  } else {
    // Not a point: this is either a pan or a click that adds one, and which it
    // was is only known on pointerup, once the cursor has moved or not.
    state.pan = { sx, sy, tx: state.tx, ty: state.ty, moved: false }
  }
  draw()
})

canvas.addEventListener('pointermove', (e) => {
  if (!state.img) return
  const { sx, sy } = cursor(e)
  if (state.drag >= 0) {
    state.pts[state.drag] = { x: toImageX(sx) + state.grab.x, y: toImageY(sy) + state.grab.y }
    showTip(state.drag, sx, sy)
    changed()
    return
  }
  if (state.pan) {
    const dx = sx - state.pan.sx
    const dy = sy - state.pan.sy
    if (!state.pan.moved && Math.hypot(dx, dy) > 3) state.pan.moved = true
    if (state.pan.moved) {
      state.tx = state.pan.tx + dx
      state.ty = state.pan.ty + dy
      draw()
    }
    return
  }
  const i = pickPoint(sx, sy)
  const seg = i >= 0 ? null : pickSegment(sx, sy)
  const segMoved = (seg?.i ?? -1) !== (state.seg?.i ?? -1) || Boolean(seg) !== Boolean(state.seg)
  if (i >= 0) showTip(i, sx, sy)
  else tip.style.display = 'none'
  if (i !== state.hover || seg || segMoved) {
    state.hover = i
    state.seg = seg
    renderList()
    draw()
  }
})

canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !state.img) return
  const { sx, sy } = cursor(e)
  if (state.drag >= 0) {
    state.drag = -1
    state.hover = pickPoint(sx, sy)
    changed()
  } else if (state.pan && !state.pan.moved) {
    addPoint(toImageX(sx), toImageY(sy))
  }
  state.pan = null
})

canvas.addEventListener('pointerleave', () => {
  if (state.drag >= 0) return
  tip.style.display = 'none'
  state.hover = -1
  state.seg = null
  changed()
})

canvas.addEventListener('contextmenu', (e) => {
  if (!state.img) return
  e.preventDefault()
  const { sx, sy } = cursor(e)
  const i = pickPoint(sx, sy)
  if (i >= 0) removePoint(i)
})

canvas.addEventListener('wheel', (e) => {
  if (!state.img) return
  e.preventDefault()
  const { sx, sy } = cursor(e)
  const f = Math.exp(-e.deltaY * 0.0015)
  const next = Math.max(0.02, Math.min(64, state.scale * f))
  const k = next / state.scale
  state.tx = sx - (sx - state.tx) * k
  state.ty = sy - (sy - state.ty) * k
  state.scale = next
  draw()
}, { passive: false })

// --- the image --------------------------------------------------------------

function loadFile(file) {
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.onload = () => {
    state.img = img
    state.name = file.name
    state.pts = []
    hint.style.display = 'none'
    statusEl.textContent = `${file.name} -- ${img.naturalWidth}x${img.naturalHeight}`
    document.title = `${file.name} -- polygon tracer`
    fit()
    renderList()
  }
  img.onerror = () => {
    URL.revokeObjectURL(url)
    statusEl.textContent = `could not decode "${file.name}"`
  }
  img.src = url
}

// --- drop, and the second image's own tab -----------------------------------

const pendingHandoff = new Map() // token -> File, answered once when that child asks

function openInTab(file) {
  const token = Math.random().toString(36).slice(2)
  pendingHandoff.set(token, file)
  const win = window.open(`${location.pathname}#recv=${token}`, '_blank')
  if (!win) {
    pendingHandoff.delete(token)
    statusEl.textContent = 'popup blocked -- allow popups here to open a second image in its own tab'
    return
  }
  statusEl.textContent = `${state.name} -- ${state.img.naturalWidth}x${state.img.naturalHeight} (opened "${file.name}" in a new tab)`
}

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return
  const msg = e.data
  if (msg?.aurora === 'poly-ready' && pendingHandoff.has(msg.token)) {
    e.source.postMessage({ aurora: 'poly-image', file: pendingHandoff.get(msg.token) }, location.origin)
    pendingHandoff.delete(msg.token)
  } else if (msg?.aurora === 'poly-image') {
    loadFile(msg.file)
  }
})

let dragDepth = 0
window.addEventListener('dragenter', (e) => {
  e.preventDefault()
  if (++dragDepth === 1) document.body.classList.add('dragging')
})
window.addEventListener('dragover', (e) => {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
})
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0
    document.body.classList.remove('dragging')
  }
})
window.addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  document.body.classList.remove('dragging')
  const file = e.dataTransfer.files[0]
  if (!file) {
    statusEl.textContent = 'that drop carried no file'
    return
  }
  // Checked here, before the branch: a non-image must not cost a tab that would
  // then have nothing to show.
  if (!file.type.startsWith('image/')) {
    statusEl.textContent = `"${file.name}" is ${file.type || 'of unknown type'}, not an image`
    return
  }
  if (state.img) openInTab(file)
  else loadFile(file)
})

// --- buttons ----------------------------------------------------------------

document.getElementById('fit').addEventListener('click', fit)

document.getElementById('clear').addEventListener('click', () => {
  state.pts = []
  state.hover = -1
  state.seg = null
  changed()
})

document.getElementById('copy').addEventListener('click', async () => {
  if (!state.img) return
  const json = JSON.stringify({
    image: state.name,
    width: state.img.naturalWidth,
    height: state.img.naturalHeight,
    points: state.pts.map((p) => [Number(p.x.toFixed(2)), Number(p.y.toFixed(2))]),
  })
  await navigator.clipboard.writeText(json)
  statusEl.textContent = `copied ${state.pts.length} points`
})

window.addEventListener('resize', draw)

// A tab opened by openInTab() above: ask the opener for the file it is holding
// for this token, then drop the token so a reload cannot re-ask for it.
const recv = new URLSearchParams(location.hash.slice(1)).get('recv')
if (recv && window.opener) {
  history.replaceState(null, '', location.pathname)
  window.opener.postMessage({ aurora: 'poly-ready', token: recv }, location.origin)
}

renderList()
draw()
