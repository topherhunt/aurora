// ---------------------------------------------------------------------------
// Bakes the 128x128 character texture by direct resample, not a 3D
// rasterizer bake -- the loft's own UV space (u = ring angle/2pi, v = height
// fraction) already tiles into four 0.25-wide angular bands, one per source
// view, because loft-mesh.mjs's ring() puts theta=0 at front and increases
// toward +X (right). So for any output texel we know exactly which source
// image and which row of it to read.
//
// ⚠️ UNVERIFIED CONVENTION, flag for stage 4 of the plan (first real
// character sheet): which edge of the front/back image is the character's
// own left vs right, and which way the side view faces, can't be nailed down
// without real generated art in hand. MIRROR_SIDE and the row.min/max
// mapping below are a best guess, consistent with itself, and are the first
// thing to check by eye against a real bake.
// ---------------------------------------------------------------------------

const BAND_WIDTH = 0.25
const FEATHER = 0.03

function nearestRow(profile, y) {
  for (let dy = 0; dy <= 30; dy++) {
    for (const yy of dy === 0 ? [y] : [y - dy, y + dy]) {
      const row = profile.rows[Math.max(profile.top, Math.min(profile.bottom, yy))]
      if (row) return row
    }
  }
  return null
}

function sampleImage({ w, h, rgba }, x, y) {
  const xi = Math.max(0, Math.min(w - 1, Math.round(x)))
  const yi = Math.max(0, Math.min(h - 1, Math.round(y)))
  const i = (yi * w + xi) * 4
  return [rgba[i], rgba[i + 1], rgba[i + 2]]
}

const BANDS = [
  { source: 'front', mirror: false },
  { source: 'side', mirror: false },   // right side
  { source: 'back', mirror: false },
  { source: 'side', mirror: true },    // left = right side image, mirrored
]

/**
 * views: { front, side, back } -- each `{w,h,rgba}` from chromakey.decodeSheet.
 * profiles: { front, side, back } -- each from chromakey.silhouetteProfile,
 *   computed by the caller (which already needed them for loft-mesh.mjs).
 * Returns { w, h, rgba } for the 128x128 baked texture (opaque; every texel
 * is sampled from inside some view's silhouette by construction).
 */
export function bakeTexture(views, profiles, size = 128) {
  const sampleAt = (bandIdx, p, v) => {
    const band = BANDS[bandIdx]
    const img = views[band.source]
    const profile = profiles[band.source]
    const eff = band.mirror ? 1 - p : p
    const y = Math.round(profile.bottom - v * (profile.bottom - profile.top))
    const row = nearestRow(profile, y)
    if (!row) return [255, 0, 255] // shouldn't happen; loud magenta if it ever does
    const x = row.min + eff * (row.max - row.min)
    return sampleImage(img, x, y)
  }

  const rgba = new Uint8Array(size * size * 4)
  for (let ty = 0; ty < size; ty++) {
    const v = 1 - ty / (size - 1) // texel row 0 is v=1 (top), matching PNG row-0-is-top
    for (let tx = 0; tx < size; tx++) {
      const u = tx / size
      const shift = ((u + BAND_WIDTH / 2) % 1 + 1) % 1
      const bandIdx = Math.floor(shift / BAND_WIDTH)
      const p = (shift - bandIdx * BAND_WIDTH) / BAND_WIDTH

      let [r, g, b] = sampleAt(bandIdx, p, v)
      if (p < FEATHER) {
        const [r2, g2, b2] = sampleAt((bandIdx + 3) % 4, 1, v)
        const t = 0.5 + 0.5 * (p / FEATHER)
        r = r2 + (r - r2) * t; g = g2 + (g - g2) * t; b = b2 + (b - b2) * t
      } else if (p > 1 - FEATHER) {
        const [r2, g2, b2] = sampleAt((bandIdx + 1) % 4, 0, v)
        const t = 0.5 + 0.5 * ((p - (1 - FEATHER)) / FEATHER)
        r = r + (r2 - r) * t; g = g + (g2 - g) * t; b = b + (b2 - b) * t
      }
      const i = (ty * size + tx) * 4
      rgba[i] = Math.round(r); rgba[i + 1] = Math.round(g); rgba[i + 2] = Math.round(b); rgba[i + 3] = 255
    }
  }
  return { w: size, h: size, rgba }
}
