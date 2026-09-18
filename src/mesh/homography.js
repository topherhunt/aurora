// ---------------------------------------------------------------------------
// The projective map between the unit square and a quadrilateral, as a 3x3
// matrix in row-major order. A leaf cut from a hand-marked QUAD of its
// photograph is warped onto a square texture (tools/props/warp-quad.mjs), and a
// card or ribbon built on the quad's own outline hands every vertex the uv the
// warp sent its corner to -- squareToQuad forward for the resampler, its
// inverse for the mesh. Pure arithmetic, shared by node and the browser.
// ---------------------------------------------------------------------------

/**
 * Heckbert's unit-square-to-quad. Corners in scan order: (0,0) -> p0,
 * (1,0) -> p1, (1,1) -> p2, (0,1) -> p3. Throws on a degenerate quad.
 */
export function squareToQuad(p0, p1, p2, p3) {
  const [x0, y0] = p0
  const [x1, y1] = p1
  const [x2, y2] = p2
  const [x3, y3] = p3
  const dx1 = x1 - x2
  const dx2 = x3 - x2
  const dx3 = x0 - x1 + x2 - x3
  const dy1 = y1 - y2
  const dy2 = y3 - y2
  const dy3 = y0 - y1 + y2 - y3
  if (dx3 === 0 && dy3 === 0) {
    return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1]
  }
  const den = dx1 * dy2 - dx2 * dy1
  if (!den) throw new Error('squareToQuad: degenerate quad')
  const g = (dx3 * dy2 - dx2 * dy3) / den
  const h = (dx1 * dy3 - dx3 * dy1) / den
  return [
    x1 - x0 + g * x1, x3 - x0 + h * x3, x0,
    y1 - y0 + g * y1, y3 - y0 + h * y3, y0,
    g, h, 1,
  ]
}

/** The quad-to-square map: the adjugate of squareToQuad's matrix (a projective map is scale-free, so no determinant divide). */
export function quadToSquare(p0, p1, p2, p3) {
  const [a, b, c, d, e, f, g, h, i] = squareToQuad(p0, p1, p2, p3)
  return [
    e * i - f * h, c * h - b * i, b * f - c * e,
    f * g - d * i, a * i - c * g, c * d - a * f,
    d * h - e * g, b * g - a * h, a * e - b * d,
  ]
}

/** Apply a 3x3 projective map to a point. */
export function applyHomography(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8]
  if (Math.abs(w) < 1e-12) throw new Error('applyHomography: point at infinity')
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w]
}
