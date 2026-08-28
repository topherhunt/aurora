// ---------------------------------------------------------------------------
// Magenta chroma-key and per-row silhouette extraction for a character sheet
// view (front, side, or back). One image in, an alpha mask and a width
// profile out; loft-mesh.mjs turns two such profiles (front + side) into a
// mesh, bake-texture.mjs samples the source pixels directly.
// ---------------------------------------------------------------------------

import { readPng } from '../props/png.mjs'

/** Reads a character-sheet view. Returns { w, h, rgba } (rgba is Uint8Array, 4 bytes/px). */
export function decodeSheet(file) {
  const { width, height, channels, data } = readPng(file)
  if (channels === 4) return { w: width, h: height, rgba: data }
  if (channels === 3) {
    const rgba = new Uint8Array(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = data[i * 3]; rgba[i * 4 + 1] = data[i * 3 + 1]; rgba[i * 4 + 2] = data[i * 3 + 2]; rgba[i * 4 + 3] = 255
    }
    return { w: width, h: height, rgba }
  }
  throw new Error(`${file}: expected RGB or RGBA, got ${channels} channels`)
}

// The key is a soft threshold on "magenta-ness" (r and b both high, g low),
// not exact-colour matching, because a generated image's background is
// rarely a flat #FF00FF -- there is JPEG-ish noise and anti-aliased edges
// against the figure. LO/HI is the feather band; tune against real output
// once stage 4 of the plan reaches a real character sheet.
const LO = 60, HI = 140

/** Keys magenta out of `{w,h,rgba}`, returns a Uint8Array alpha mask (0..255), same size. */
export function keyMagenta({ w, h, rgba }) {
  const alpha = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2]
    if (r < 60 || b < 60) { alpha[i] = 255; continue }
    const score = (r + b) / 2 - g
    const t = Math.min(1, Math.max(0, (score - LO) / (HI - LO)))
    alpha[i] = Math.round((1 - t) * 255)
  }
  return alpha
}

// Corner-sampled background key: doesn't assume the background is magenta at
// all, just that it's whatever solid-ish colour sits in the four corners (Flux
// doesn't always land exactly on #FF00FF, especially on side/back views
// generated via an image reference rather than from scratch). Samples a small
// patch at each corner, bilinearly interpolates a per-pixel expected
// background colour across the image (handles a soft gradient/vignette, not
// just a flat fill), and feathers alpha by Euclidean colour distance from
// that expectation -- same LO/HI feather-band idea as keyMagenta, just not
// tied to a specific hue.
const CORNER_PATCH = 10

function cornerColor(rgba, w, h, cx, cy) {
  let r = 0, g = 0, b = 0, n = 0
  for (let y = cy; y < cy + CORNER_PATCH; y++) {
    for (let x = cx; x < cx + CORNER_PATCH; x++) {
      const i = (y * w + x) * 4
      r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++
    }
  }
  return [r / n, g / n, b / n]
}

const lerp = (a, b, t) => a + (b - a) * t

// Distance is measured in CHROMA space (colour with luma subtracted out), not
// raw RGB -- a chroma-keyed sheet often has a soft coloured contact-shadow
// under the figure's feet (Flux renders ambient bounce off the background
// colour) that's much darker than the flat background but the *same hue*.
// Raw RGB distance treats "darker" as "different", leaving that shadow as a
// visible halo; chroma distance only cares about hue/saturation, so a dim
// magenta shadow keys out just as cleanly as the bright magenta field around
// it, while genuine foreground colours (leather, skin, hair) -- which sit far
// from the background hue regardless of their own brightness -- still don't.
function chroma(r, g, b) {
  const y = (r + g + b) / 3
  return [r - y, g - y, b - y]
}

/**
 * Keys the background out of `{w,h,rgba}` by sampling its four corners
 * instead of assuming a fixed colour. Returns a Uint8Array alpha mask, hard
 * binary (0 or 255 only, no feathered/blended edge) -- a soft edge is what
 * was leaving a visible magenta fringe on fine detail (fur, hair) once
 * composited over anything but the exact keyed-out background, since a
 * half-transparent boundary pixel still carries its original, background-
 * contaminated colour underneath that partial alpha.
 *
 * That contamination is corrected too, in place, on the pixels that DO end
 * up opaque: `lo`/`hi` still define a soft band internally (same
 * chroma-distance idea as before), used only to estimate how much of each
 * near-edge pixel's colour is background bleed, and unmix it out before the
 * hard cutoff is applied. `cutoff` (in the same 0..1 band-fraction terms) is
 * where the binary line actually falls -- pushed toward `hi` by default
 * (aggressive) rather than the band's midpoint, since eroding a pixel of
 * real edge is a much smaller problem than leaving a ring of magenta-tinted
 * fur/hair behind.
 */
// A second, luma-aware guard on top of the chroma-distance test above. Chroma
// distance deliberately ignores luma (see chroma()'s comment, for the dim-
// shadow case) -- but that same luma-blindness lets a background pixel that's
// blended into something DARK (a black fur strand, a hair wisp) read as "far"
// in chroma space even though it's still obviously magenta in raw RGB: fading
// bright magenta (255,0,255) toward black keeps r and b well above g the
// whole way down, but drags luma down enough to skew the luma-normalised
// chroma vector away from the background's. rawMagentaScore is the same
// hue-only score keyMagenta used before chroma distance existed -- cheap,
// luma-independent, and enough on its own to catch what chroma distance
// misses on dark fur/hair edges.
function rawMagentaScore(r, g, b) { return (r + b) / 2 - g }
const RAW_MAGENTA_CUTOFF = 50

export function keyBackground({ w, h, rgba }, { lo = 25, hi = 65, cutoff = 0.99, closeRadius = 0 } = {}) {
  if (w < CORNER_PATCH * 2 || h < CORNER_PATCH * 2) throw new Error(`image ${w}x${h} too small for ${CORNER_PATCH}px corner sampling`)
  const tl = cornerColor(rgba, w, h, 0, 0)
  const tr = cornerColor(rgba, w, h, w - CORNER_PATCH, 0)
  const bl = cornerColor(rgba, w, h, 0, h - CORNER_PATCH)
  const br = cornerColor(rgba, w, h, w - CORNER_PATCH, h - CORNER_PATCH)
  const chromaTl = chroma(...tl), chromaTr = chroma(...tr), chromaBl = chroma(...bl), chromaBr = chroma(...br)

  const alpha = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const v = h > 1 ? y / (h - 1) : 0
    for (let x = 0; x < w; x++) {
      const u = w > 1 ? x / (w - 1) : 0
      const bgR = lerp(lerp(tl[0], tr[0], u), lerp(bl[0], br[0], u), v)
      const bgG = lerp(lerp(tl[1], tr[1], u), lerp(bl[1], br[1], u), v)
      const bgB = lerp(lerp(tl[2], tr[2], u), lerp(bl[2], br[2], u), v)
      const bgCr = lerp(lerp(chromaTl[0], chromaTr[0], u), lerp(chromaBl[0], chromaBr[0], u), v)
      const bgCg = lerp(lerp(chromaTl[1], chromaTr[1], u), lerp(chromaBl[1], chromaBr[1], u), v)
      const bgCb = lerp(lerp(chromaTl[2], chromaTr[2], u), lerp(chromaBl[2], chromaBr[2], u), v)

      const i = (y * w + x) * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      const [cr, cg, cb] = chroma(r, g, b)
      const dr = cr - bgCr, dg = cg - bgCg, db = cb - bgCb
      const dist = Math.sqrt(dr * dr + dg * dg + db * db)
      const t = Math.min(1, Math.max(0, (dist - lo) / (hi - lo)))
      const magentaScore = rawMagentaScore(r, g, b)

      if (t >= cutoff && magentaScore < RAW_MAGENTA_CUTOFF) {
        // Unmix the background's contribution to this pixel's colour,
        // proportional to how confidently-foreground it is (t). A pixel
        // right at the cutoff is still assumed ~cutoff background-blended;
        // clamping the divisor to `cutoff` (rather than letting it approach
        // 0) keeps that unmix from blowing up into noise right at the edge.
        const unmix = Math.max(t, cutoff)
        rgba[i] = Math.max(0, Math.min(255, Math.round(bgR + (r - bgR) / unmix)))
        rgba[i + 1] = Math.max(0, Math.min(255, Math.round(bgG + (g - bgG) / unmix)))
        rgba[i + 2] = Math.max(0, Math.min(255, Math.round(bgB + (b - bgB) / unmix)))
        alpha[y * w + x] = 255
      } else {
        alpha[y * w + x] = 0
      }
    }
  }
  keepEnclosedRegions(alpha, w, h, closeRadius)
  return alpha
}

// A per-pixel colour test alone can't tell "this pixel is the background"
// from "this pixel just happens to be a similar colour to the background" --
// a character/creature painted in a hue close to the chroma-key colour (e.g.
// Glimmerfin's magenta-purple scales against a magenta key) loses chunks of
// its own body to the key, breaking what should be one contiguous solid into
// a lattice of holes.
//
// The background is not just "a similar colour" though -- it is specifically
// the region reachable from outside the figure without crossing it, i.e. the
// set of alpha=0 pixels 4-connected to the image border. Anything colour-
// keyed as background but NOT reachable that way is enclosed BY the figure
// (surrounded on all sides by kept pixels) and gets reclassified to
// foreground, unmodified -- it was never unmixed against the background
// above, since only pixels already classified foreground went through that
// step, so there is nothing to undo.
//
// `closeRadius` (0 by default -- exact behaviour above, unchanged) additionally
// seals off any GENUINE gap narrower than 2*closeRadius+1 px before the flood
// fill runs, so a real but hairline background-coloured seam (e.g. the slivers
// between a dorsal fin's rays) can no longer act as a leak channel from the
// true outer background into an interior hole one pixel away from it. This is
// a deliberate trade a caller opts into: characters need their real gaps (leg
// separation, underarm) to stay open for loft-mesh.mjs's silhouette-based
// limb measurement, but a flat fish sprite has no such consumer and reads
// better as one solid silhouette with no interior holes at all -- see
// tools/fauna/fish-prompt.mjs's caller.
function keepEnclosedRegions(alpha, w, h, closeRadius = 0) {
  const bgCandidate = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) bgCandidate[i] = alpha[i] === 0 ? 1 : 0

  const searchMask = closeRadius > 0 ? erode(bgCandidate, w, h, closeRadius) : bgCandidate

  const reached = new Uint8Array(w * h)
  const stack = []
  const pushIfBg = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return
    const i = y * w + x
    if (searchMask[i] && !reached[i]) { reached[i] = 1; stack.push(i) }
  }
  for (let x = 0; x < w; x++) { pushIfBg(x, 0); pushIfBg(x, h - 1) }
  for (let y = 0; y < h; y++) { pushIfBg(0, y); pushIfBg(w - 1, y) }
  while (stack.length) {
    const i = stack.pop()
    const x = i % w, y = (i - x) / w
    pushIfBg(x - 1, y); pushIfBg(x + 1, y); pushIfBg(x, y - 1); pushIfBg(x, y + 1)
  }

  // Growing the reached region back out by the same radius it was eroded by
  // restores the true background's real extent near actual foreground edges
  // (which the erosion also ate into) -- without this, closeRadius would
  // leave a false ring of "foreground" closeRadius pixels wide all around the
  // real silhouette.
  const trueBg = closeRadius > 0 ? dilate(reached, w, h, closeRadius) : reached

  for (let i = 0; i < w * h; i++) {
    if (bgCandidate[i] && trueBg[i]) alpha[i] = 0
    else if (bgCandidate[i]) alpha[i] = 255 // was background-candidate but unreachable/sealed off -- an enclosed hole
  }
}

// Separable box erosion/dilation over a 0/1 mask (Chebyshev/"square" window,
// radius r -- a pixel survives erosion only if every pixel within r in both
// x and y is also 1). Two 1-D min/max passes instead of one 2-D pass: O(w*h*r)
// either way at this scale, but the separable form is simple and fast enough
// (r stays small, a handful of px) without needing a sliding-window minimum.
function erode(mask, w, h, r) { return boxFilter(mask, w, h, r, Math.min) }
function dilate(mask, w, h, r) { return boxFilter(mask, w, h, r, Math.max) }

function boxFilter(mask, w, h, r, reduce) {
  const tmp = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = mask[y * w + x]
      for (let dx = 1; dx <= r; dx++) {
        if (x - dx >= 0) v = reduce(v, mask[y * w + (x - dx)])
        if (x + dx < w) v = reduce(v, mask[y * w + (x + dx)])
      }
      tmp[y * w + x] = v
    }
  }
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = tmp[y * w + x]
      for (let dy = 1; dy <= r; dy++) {
        if (y - dy >= 0) v = reduce(v, tmp[(y - dy) * w + x])
        if (y + dy < h) v = reduce(v, tmp[(y + dy) * w + x])
      }
      out[y * w + x] = v
    }
  }
  return out
}

/**
 * Crops `{w,h,rgba}` (plus its `alpha` mask and `profile` from
 * silhouetteProfile) down to the figure's own bounding box -- billboard.mjs
 * and the reference-plane endpoint in vite.config.js both need exactly this
 * crop, just at different final uses.
 */
export function cropToFigure({ w, rgba }, alpha, profile) {
  let left = Infinity, right = -Infinity
  for (let y = profile.top; y <= profile.bottom; y++) {
    const row = profile.rows[y]
    if (!row) continue
    if (row.min < left) left = row.min
    if (row.max > right) right = row.max
  }
  const top = profile.top, bottom = profile.bottom
  const cw = right - left + 1, ch = bottom - top + 1

  const out = new Uint8Array(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const src = ((y + top) * w + (x + left)) * 4
      const dst = (y * cw + x) * 4
      out[dst] = rgba[src]; out[dst + 1] = rgba[src + 1]; out[dst + 2] = rgba[src + 2]
      out[dst + 3] = alpha[(y + top) * w + (x + left)]
    }
  }
  return { w: cw, h: ch, rgba: out }
}

// Below this width, an internal transparent run within a row is treated as
// noise (a stray unkeyed pixel or anti-aliasing), not a real separation
// between two silhouette blobs (e.g. the legs in an "arms at sides, legs
// together" pose, which are genuinely gapped from ankle to roughly mid-
// thigh). Real gaps measured off actual character sheets run 40-330px wide;
// noise is a handful of pixels.
const MIN_GAP_PX = 10

/**
 * Per-row [minX, maxX] silhouette extent (alpha > 128), plus the overall
 * figure's top/bottom rows. A row with no opaque pixel is `null` in `rows`.
 * Each row also carries `gapMin`/`gapMax` -- the widest internal transparent
 * run within [min,max], i.e. a real gap between two separate blobs on that
 * row (both `null` if there's no such run at least `MIN_GAP_PX` wide).
 * Throws if the figure has fewer than 8 non-empty rows -- too thin a
 * silhouette to loft, almost certainly a keying failure rather than a real
 * character.
 */
export function silhouetteProfile(alpha, w, h) {
  const rows = new Array(h).fill(null)
  let top = -1, bottom = -1, nonEmpty = 0
  for (let y = 0; y < h; y++) {
    let min = -1, max = -1
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > 128) { if (min < 0) min = x; max = x }
    }
    if (min >= 0) {
      let gapMin = null, gapMax = null, runStart = -1, bestLen = 0
      for (let x = min; x <= max; x++) {
        if (alpha[y * w + x] <= 128) {
          if (runStart < 0) runStart = x
        } else if (runStart >= 0) {
          const len = x - runStart
          if (len > bestLen) { bestLen = len; gapMin = runStart; gapMax = x }
          runStart = -1
        }
      }
      if (bestLen < MIN_GAP_PX) { gapMin = null; gapMax = null }
      rows[y] = { min, max, gapMin, gapMax }
      nonEmpty++
      if (top < 0) top = y
      bottom = y
    }
  }
  if (nonEmpty < 8) throw new Error('silhouette has fewer than 8 non-empty rows -- chroma key likely failed')
  return { top, bottom, rows }
}

/**
 * The transpose of silhouetteProfile: per-column [minY, maxY] silhouette
 * extent, plus the overall figure's left/right columns. Used for a T-pose
 * arm, whose long axis runs horizontally, so measuring it needs a per-column
 * (not per-row) scan. No gap detection here -- callers only query columns
 * clearly out in the arm/sleeve region, where there's no torso ambiguity to
 * resolve (unlike the leg gap above, which shares its row with the torso
 * span).
 */
export function columnProfile(alpha, w, h) {
  const cols = new Array(w).fill(null)
  let left = -1, right = -1, nonEmpty = 0
  for (let x = 0; x < w; x++) {
    let min = -1, max = -1
    for (let y = 0; y < h; y++) {
      if (alpha[y * w + x] > 128) { if (min < 0) min = y; max = y }
    }
    if (min >= 0) {
      cols[x] = { min, max }
      nonEmpty++
      if (left < 0) left = x
      right = x
    }
  }
  if (nonEmpty < 8) throw new Error('silhouette has fewer than 8 non-empty columns -- chroma key likely failed')
  return { left, right, cols }
}
