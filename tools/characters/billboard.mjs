// ---------------------------------------------------------------------------
// The distant-crowd billboard: the front view's silhouette, cropped and
// alpha-keyed, sized to the mesh's real-world bounding box. This is what a
// wandering NPC renders as once it's far enough away that LOD2 isn't worth
// its triangles either -- "people wandering around like ants".
// ---------------------------------------------------------------------------

import { cropToFigure } from './chromakey.mjs'

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
  const crop = cropToFigure(front, alpha, profile)
  const pixelsPerMeter = (profile.bottom - profile.top) / heightM
  return { ...crop, worldWidthM: crop.w / pixelsPerMeter, worldHeightM: crop.h / pixelsPerMeter }
}
