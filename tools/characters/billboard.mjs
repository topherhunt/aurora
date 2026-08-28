// ---------------------------------------------------------------------------
// The distant-crowd billboard: the front view's silhouette, cropped and
// alpha-keyed, sized to the mesh's real-world bounding box. This is what a
// wandering NPC renders as once it's far enough away that LOD2 isn't worth
// its triangles either -- "people wandering around like ants".
// ---------------------------------------------------------------------------

/**
 * front: `{w,h,rgba}` from chromakey.decodeSheet (front view).
 * alpha: Uint8Array from chromakey.keyMagenta(front).
 * profile: from chromakey.silhouetteProfile(alpha, front.w, front.h).
 * heightM: the character's standing height, for the returned world size.
 *
 * Returns { w, h, rgba, worldWidthM, worldHeightM } -- a cropped, keyed RGBA
 * image ready for writePng, plus the size a runtime quad should use.
 */
export function buildBillboard(front, alpha, profile, heightM) {
  let left = Infinity, right = -Infinity
  for (let y = profile.top; y <= profile.bottom; y++) {
    const row = profile.rows[y]
    if (!row) continue
    if (row.min < left) left = row.min
    if (row.max > right) right = row.max
  }
  const top = profile.top, bottom = profile.bottom
  const w = right - left + 1, h = bottom - top + 1

  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((y + top) * front.w + (x + left)) * 4
      const dst = (y * w + x) * 4
      rgba[dst] = front.rgba[src]; rgba[dst + 1] = front.rgba[src + 1]; rgba[dst + 2] = front.rgba[src + 2]
      rgba[dst + 3] = alpha[(y + top) * front.w + (x + left)]
    }
  }

  const pixelsPerMeter = (bottom - top) / heightM
  return { w, h, rgba, worldWidthM: w / pixelsPerMeter, worldHeightM: h / pixelsPerMeter }
}
