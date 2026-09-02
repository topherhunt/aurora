// The chroma-key bench, served at /chroma-key. Drop an image, click a colour in
// it, and every pixel within `threshold` of that colour goes transparent --
// black backgrounds off a sprite sheet, a flat studio backdrop, a solid fill
// behind a logo. Download is a PNG with the alpha baked in.
//
// Distance is plain RGB, normalised so 1 is the diagonal of the colour cube.
// Not the chroma (luma-subtracted) distance tools/characters/chromakey.mjs uses
// for its magenta sheets: chroma distance deliberately ignores brightness, which
// makes "key the blacks" -- the case this page exists for -- impossible, since
// black and white sit at the same place in chroma space.
//
// No three.js, no dev-server endpoint, so it works the same from a build.

const view = document.getElementById('view')
const vctx = view.getContext('2d')
const hint = document.getElementById('hint')
const status = document.getElementById('status')
const swatch = document.getElementById('swatch')
const keyHex = document.getElementById('keyHex')
const threshold = document.getElementById('threshold')
const softness = document.getElementById('softness')
const thresholdV = document.getElementById('thresholdV')
const softnessV = document.getElementById('softnessV')
const btnKeyed = document.getElementById('showKeyed')
const btnSource = document.getElementById('showSource')
const btnDownload = document.getElementById('download')

let source = null // the dropped image, as a canvas
let pixels = null // its ImageData, read once
let keyed = null // the keyed result, or null until an image is loaded
let name = 'image'
let showSource = false
let place = null // where the last draw put the image, for click -> pixel
let cleared = 0 // pixels the current key took fully transparent

const CUBE = Math.sqrt(3 * 255 * 255) // longest possible RGB distance

function canvasOf(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
const keyRGB = () => [1, 3, 5].map((i) => parseInt(swatch.value.slice(i, i + 2), 16))

// Alpha falls from opaque to clear across [t, t + soft] of normalised distance:
// inside the threshold the pixel is gone, past the band it is untouched, and the
// band itself is what keeps an anti-aliased edge from turning into stair-steps.
// Existing alpha is multiplied through, never overwritten.
function key() {
  const [kr, kg, kb] = keyRGB()
  const t = Number(threshold.value) * CUBE
  const soft = Number(softness.value) * CUBE
  const src = pixels.data
  const out = new ImageData(source.width, source.height)
  const dst = out.data
  dst.set(src)

  cleared = 0
  for (let i = 0; i < src.length; i += 4) {
    const dr = src[i] - kr, dg = src[i + 1] - kg, db = src[i + 2] - kb
    const d = Math.sqrt(dr * dr + dg * dg + db * db)
    const f = soft > 0 ? Math.min(1, Math.max(0, (d - t) / soft)) : (d > t ? 1 : 0)
    dst[i + 3] = Math.round(src[i + 3] * f)
    if (dst[i + 3] === 0) cleared++
  }

  keyed = canvasOf(source.width, source.height)
  keyed.getContext('2d').putImageData(out, 0, 0)
}

// --- the view ---------------------------------------------------------------

// A checkerboard, or transparent pixels read as whatever the page is behind them.
function checker(size) {
  const c = canvasOf(size * 2, size * 2)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#20262e'
  ctx.fillRect(0, 0, size * 2, size * 2)
  ctx.fillStyle = '#161b22'
  ctx.fillRect(0, 0, size, size)
  ctx.fillRect(size, size, size, size)
  return ctx.createPattern(c, 'repeat')
}

function draw() {
  const dpr = window.devicePixelRatio || 1
  const stage = view.parentElement.getBoundingClientRect()
  view.width = Math.max(1, Math.round(stage.width * dpr))
  view.height = Math.max(1, Math.round(stage.height * dpr))
  vctx.setTransform(1, 0, 0, 1, 0, 0)
  vctx.clearRect(0, 0, view.width, view.height)
  if (!source) return

  const img = showSource || !keyed ? source : keyed
  const pad = 16 * dpr
  const scale = Math.min((view.width - 2 * pad) / img.width, (view.height - 2 * pad) / img.height)
  const w = img.width * scale
  const h = img.height * scale
  place = { x: (view.width - w) / 2, y: (view.height - h) / 2, scale }

  vctx.fillStyle = checker(8 * dpr)
  vctx.fillRect(place.x, place.y, w, h)
  vctx.imageSmoothingEnabled = scale < 1
  vctx.drawImage(img, place.x, place.y, w, h)
}

function sync() {
  keyHex.textContent = swatch.value
  thresholdV.textContent = Number(threshold.value).toFixed(3)
  softnessV.textContent = Number(softness.value).toFixed(3)
  btnKeyed.setAttribute('aria-pressed', String(!showSource))
  btnSource.setAttribute('aria-pressed', String(showSource))
  btnDownload.disabled = !keyed
  if (source) {
    const pct = ((cleared / (source.width * source.height)) * 100).toFixed(1)
    status.textContent = `${name} ${source.width}x${source.height} -- ${pct}% cleared`
  }
  draw()
}

function rekey() {
  if (!source) return
  key()
  sync()
}

function sample(e) {
  if (!source || !place) return
  const dpr = window.devicePixelRatio || 1
  const rect = view.getBoundingClientRect()
  const x = Math.floor(((e.clientX - rect.left) * dpr - place.x) / place.scale)
  const y = Math.floor(((e.clientY - rect.top) * dpr - place.y) / place.scale)
  if (x < 0 || y < 0 || x >= source.width || y >= source.height) return
  const i = (y * source.width + x) * 4
  swatch.value = hex(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2])
  rekey()
}

function load(file) {
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.onload = () => {
    URL.revokeObjectURL(url)
    source = canvasOf(img.naturalWidth, img.naturalHeight)
    source.getContext('2d').drawImage(img, 0, 0)
    pixels = source.getContext('2d').getImageData(0, 0, source.width, source.height)
    name = file.name.replace(/\.[^.]+$/, '')
    showSource = false
    hint.style.display = 'none'
    rekey()
  }
  img.onerror = () => {
    URL.revokeObjectURL(url)
    status.textContent = `could not decode ${file.name}`
  }
  img.src = url
}

// --- wiring -----------------------------------------------------------------

btnKeyed.onclick = () => { showSource = false; sync() }
btnSource.onclick = () => { showSource = true; sync() }
threshold.oninput = softness.oninput = swatch.oninput = rekey

btnDownload.onclick = () => {
  keyed.toBlob((blob) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${name}-keyed.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10000)
  }, 'image/png')
}

const picker = document.createElement('input')
picker.type = 'file'
picker.accept = 'image/*'
picker.onchange = () => picker.files[0] && load(picker.files[0])
view.onclick = (e) => (source ? sample(e) : picker.click())

addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging') })
addEventListener('dragleave', () => document.body.classList.remove('dragging'))
addEventListener('drop', (e) => {
  e.preventDefault()
  document.body.classList.remove('dragging')
  const file = e.dataTransfer.files[0]
  if (file) load(file)
})
addEventListener('resize', draw)

sync()
