// The tileable bench, served at /tileable. Drop a texture, blend it into one
// that wraps, eyeball the result rolled, download it. Same two operations as
// tools/tileable.sh (which does it in ImageMagick from the command line):
//
//   roll  -- shift by half a tile, so whatever sat on the border lands in the
//            middle of the view where a bad seam is impossible to miss.
//   tile  -- roll a copy, then paint the untouched original back over the
//            centre through a soft-edged mask. The border of the result is
//            rolled content, whose first and last columns were adjacent in the
//            source, so it wraps exactly; the mask hides where the two meet.
//
// No three.js, no dev-server endpoint -- it works the same from a build.

const view = document.getElementById('view')
const vctx = view.getContext('2d')
const hint = document.getElementById('hint')
const status = document.getElementById('status')
const btnSource = document.getElementById('showSource')
const btnTiled = document.getElementById('showTiled')
const btnRoll = document.getElementById('roll')
const btnMake = document.getElementById('make')
const btnDownload = document.getElementById('download')
const inset = document.getElementById('inset')
const blur = document.getElementById('blur')
const insetV = document.getElementById('insetV')
const blurV = document.getElementById('blurV')

let source = null // the dropped image, as a canvas
let tiled = null // the blended result, or null until "make tileable"
let name = 'texture' // dropped filename minus its extension
let showTiled = false
let rolling = false

function canvasOf(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

// Shift the image right and down by half its size, wrapping. Four draws, one
// per corner of the wrap -- drawImage clips the parts that fall outside.
function roll(src) {
  const w = src.width
  const h = src.height
  const dx = Math.floor(w / 2)
  const dy = Math.floor(h / 2)
  const out = canvasOf(w, h)
  const ctx = out.getContext('2d')
  for (const x of [dx - w, dx]) for (const y of [dy - h, dy]) ctx.drawImage(src, x, y)
  return out
}

// A white rectangle inset from every edge, blurred into a soft falloff, held in
// the ALPHA channel: `blur(Npx)` is a gaussian of standard deviation N, the same
// as ImageMagick's `-blur 0xN`, so the two tools agree on a given pair of knobs.
function mask(w, h, insetF, blurF) {
  const x = Math.min(Math.round(w * insetF), Math.floor(w / 2) - 1)
  const y = Math.min(Math.round(h * insetF), Math.floor(h / 2) - 1)
  const sigma = Math.min(w, h) * blurF
  const out = canvasOf(w, h)
  const ctx = out.getContext('2d')
  if (sigma > 0) ctx.filter = `blur(${sigma.toFixed(2)}px)`
  ctx.fillStyle = '#fff'
  ctx.fillRect(x, y, w - 2 * x, h - 2 * y)
  return out
}

function makeTileable(src, insetF, blurF) {
  const w = src.width
  const h = src.height
  const centre = canvasOf(w, h)
  const cctx = centre.getContext('2d')
  cctx.drawImage(src, 0, 0)
  cctx.globalCompositeOperation = 'destination-in'
  cctx.drawImage(mask(w, h, insetF, blurF), 0, 0)

  const out = roll(src)
  out.getContext('2d').drawImage(centre, 0, 0)
  return out
}

// --- the view ---------------------------------------------------------------

function draw() {
  const dpr = window.devicePixelRatio || 1
  const stage = view.parentElement.getBoundingClientRect()
  view.width = Math.max(1, Math.round(stage.width * dpr))
  view.height = Math.max(1, Math.round(stage.height * dpr))
  vctx.setTransform(1, 0, 0, 1, 0, 0)
  vctx.clearRect(0, 0, view.width, view.height)
  if (!source) return

  let img = showTiled && tiled ? tiled : source
  if (rolling) img = roll(img)

  const pad = 16 * dpr
  const scale = Math.min((view.width - 2 * pad) / img.width, (view.height - 2 * pad) / img.height)
  const w = img.width * scale
  const h = img.height * scale
  vctx.imageSmoothingEnabled = scale < 1
  vctx.drawImage(img, (view.width - w) / 2, (view.height - h) / 2, w, h)
}

function sync() {
  btnSource.setAttribute('aria-pressed', String(!showTiled))
  btnTiled.setAttribute('aria-pressed', String(showTiled))
  btnRoll.setAttribute('aria-pressed', String(rolling))
  btnTiled.disabled = !tiled
  btnDownload.disabled = !tiled
  btnMake.disabled = !source
  insetV.textContent = Number(inset.value).toFixed(3)
  blurV.textContent = Number(blur.value).toFixed(3)
  if (source) {
    const square = source.width === source.height ? '' : ' -- not square'
    status.textContent = `${name} ${source.width}x${source.height}${square}${tiled ? ' -- tiled' : ''}`
  }
  draw()
}

function build() {
  if (!source) return
  tiled = makeTileable(source, Number(inset.value), Number(blur.value))
  showTiled = true
  sync()
}

function load(file) {
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.onload = () => {
    URL.revokeObjectURL(url)
    source = canvasOf(img.naturalWidth, img.naturalHeight)
    source.getContext('2d').drawImage(img, 0, 0)
    name = file.name.replace(/\.[^.]+$/, '')
    tiled = null
    showTiled = false
    hint.style.display = 'none'
    sync()
  }
  img.onerror = () => {
    URL.revokeObjectURL(url)
    status.textContent = `could not decode ${file.name}`
  }
  img.src = url
}

// --- wiring -----------------------------------------------------------------

btnSource.onclick = () => { showTiled = false; sync() }
btnTiled.onclick = () => { showTiled = true; sync() }
btnRoll.onclick = () => { rolling = !rolling; sync() }
btnMake.onclick = build

// Recomputing the blend costs one composite of a texture-sized canvas, so the
// sliders can drive it live once there is something to rebuild.
inset.oninput = blur.oninput = () => (tiled ? build() : sync())

btnDownload.onclick = () => {
  tiled.toBlob((blob) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${name}-tiled.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10000)
  }, 'image/png')
}

const picker = document.createElement('input')
picker.type = 'file'
picker.accept = 'image/*'
picker.onchange = () => picker.files[0] && load(picker.files[0])
view.onclick = () => picker.click()

addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging') })
addEventListener('dragleave', () => document.body.classList.remove('dragging'))
addEventListener('drop', (e) => {
  e.preventDefault()
  document.body.classList.remove('dragging')
  const file = e.dataTransfer.files[0]
  if (file) load(file)
})
addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') { rolling = !rolling; sync() }
})
addEventListener('resize', draw)

sync()
