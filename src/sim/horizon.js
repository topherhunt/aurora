// ---------------------------------------------------------------------------
// Horizon mapping: terrain shadows that track the sun, without a shadow map.
//
// ===========================================================================
// WHY NOT A SHADOW MAP
// ===========================================================================
//
// The thing being asked for is a mountain 6 km away putting a valley in shade.
// A cascaded shadow map that reaches 6 km on a Quest 3 needs three or four
// cascades, each one a full re-render of the terrain from the sun's point of
// view, every frame, forever. That is three or four extra passes over the
// BatchedMesh, and §7 measured the budget at ~800k triangles per frame TOTAL.
// It does not fit, and it would not fit if it were the only thing in the scene.
//
// ===========================================================================
// WHAT THIS DOES INSTEAD
// ===========================================================================
//
// The terrain does not move. So for any point on it, and any compass direction,
// the answer to "how high does the ground rise in that direction?" is a
// constant -- bake it once and the shadow test becomes a texture read.
//
//   horizon[x, z, azimuth] = max over all points P in that direction of
//                            atan( ( height(P) - height(x,z) ) / distance )
//
// A point is in sun exactly when the sun's elevation exceeds that angle. The
// whole shadow term is then one comparison, at any range, for free, and it is
// correct for every sun position rather than for a chosen few.
//
// And it comes with a second product for nothing. The same 16 angles say how
// much of the SKY each point can see, which is ambient occlusion -- a valley
// floor gets less skylight than a ridge because the valley walls are in the
// way. That is sun-independent, so it is baked once and never touched again.
//
// The costs, honestly: no shadows from anything that is not terrain (props and
// buildings cast none), and 16 MB of texture. Both are the right trade at this
// range. Contact shadows are a near-field problem and this is a far-field
// technique.
//
// ===========================================================================
// THE ALGORITHM, because the naive version is 4 billion samples
// ===========================================================================
//
// Naive raymarching from every texel in every direction is 1024^2 texels x 16
// azimuths x ~1400 steps = 23 BILLION samples. Not "slow" -- impossible.
//
// The way out is to notice what is actually being asked. Walk a straight line
// across the grid and let (x_k, y_k) be distance and height along it. Then
//
//   horizon[i] = max over j > i of ( y_j - y_i ) / ( x_j - x_i )
//
// which is the maximum SLOPE from point i to anything ahead of it. And the
// point achieving that maximum is always a vertex of the UPPER CONVEX HULL of
// the points ahead -- a point sitting below the line joining two others can
// never be the steepest thing you can see.
//
// So sweep each line from the far end backward, keeping the upper hull on a
// stack. For each new point i, pop from the near end of the stack while the
// nearest hull point is at a shallower angle than the one behind it: that
// nearest point is under the segment joining i to the one behind it, so it is
// off the hull, and -- this is the part that makes it O(n) -- it stays off the
// hull for EVERY query further back, because i itself is in the candidate set
// for all of those. Popped is popped forever. Each point is pushed once and
// popped at most once, so a line of length L costs O(L), not O(L^2).
//
// That takes the whole bake from 23 billion samples to about 34 million point
// visits: roughly one second, once, in the worker that is already running.
//
// This is Stewart's 1998 result ("Fast horizon computation at all points of a
// terrain with visibility and shading applications"), which is where to look if
// the hull argument above does not convince.
// ---------------------------------------------------------------------------

// 16 compass directions, 22.5 deg apart, bilinearly blended in the shader
// between the two straddling the sun. That is finer than it sounds: what the
// interpolation has to resolve is not the sun's position but the rate at which
// a RIDGELINE's height changes with viewing azimuth, and ridgelines at
// kilometre range are smooth in azimuth. 8 slices showed visible faceting in
// the shadow edge as the sun moved; 16 does not, and 32 doubles a 16 MB
// texture for no visible gain.
export const AZIMUTHS = 16

// Angles are stored as a byte over 0..90 degrees: 0.35 deg per step. The
// shader's softness band is about 1.5 deg wide (see HORIZON_SOFT), so the
// quantisation is four times finer than the softest edge it can produce and
// cannot be seen. A 16-bit map would be 33 MB to fix a problem that is not
// there.
const ENCODE = 255 / (Math.PI / 2)

// Softness of the shadow edge, in radians of sun elevation. The real penumbra
// of the sun is 0.53 deg -- its angular diameter -- but a shadow edge THAT hard
// at 16 m/texel shows the texel grid as a staircase. 1.5 deg is the smallest
// value where the edge reads as a smooth curve rather than as pixels, and it
// is still tight enough that a ridge shadow has a definite line.
export const HORIZON_SOFT = (1.5 * Math.PI) / 180

/**
 * Bake horizon angles and sky visibility from a square elevation grid.
 *
 * @param elev  Float32Array(n*n), row-major, elev[j*n+i], metres.
 * @param n     grid side.
 * @param cell  metres per cell.
 * @returns { horizon, sky }
 *   horizon: Uint8Array(n*n*AZIMUTHS) laid out LAYER-MAJOR --
 *            horizon[a*n*n + j*n + i] -- which is exactly the memory order a
 *            THREE.DataArrayTexture wants, so it uploads with no repacking.
 *   sky:     Uint8Array(n*n), cosine-weighted fraction of the sky hemisphere
 *            visible from each texel. This is the ambient occlusion term.
 */
export function bakeHorizon(elev, n, cell) {
  if (elev.length !== n * n) throw new Error(`bakeHorizon: elev is ${elev.length}, expected ${n * n}`)

  const size = n * n
  const horizon = new Uint8Array(size * AZIMUTHS)
  // Accumulated in float and quantised at the end: this is a mean over 16
  // slices, and rounding each term to a byte first would bias it.
  const skyAcc = new Float32Array(size)

  // Scratch, allocated once for the whole bake rather than per line. At n=1024
  // a line is at most ~1450 cells; 4n is comfortably past the diagonal.
  const cap = 4 * n
  const px = new Float64Array(cap) // distance along the line, metres
  const py = new Float64Array(cap) // height there, metres
  const pc = new Int32Array(cap) // cell index, to write the answer back
  const stack = new Int32Array(cap)

  for (let a = 0; a < AZIMUTHS; a++) {
    // The direction the SUN IS IN, as a compass azimuth: 0 = north, growing
    // clockwise, matching clock.js and the aurora. In grid indices, +i is east
    // and +j is south, so north is -j.
    const ang = (a / AZIMUTHS) * Math.PI * 2
    const di = Math.sin(ang)
    const dj = -Math.cos(ang)
    const layer = a * size

    // Step along whichever axis the direction leans on, so that consecutive
    // samples are always exactly one cell apart on that axis and every cell in
    // the grid is visited exactly once per azimuth. Stepping along the other
    // axis instead would skip cells for shallow slopes and visit some twice.
    const iMajor = Math.abs(di) >= Math.abs(dj)
    const slope = iMajor ? dj / di : di / dj
    // Metres between consecutive samples: one cell on the major axis plus
    // `slope` cells on the minor.
    const step = cell * Math.sqrt(1 + slope * slope)
    const fwd = iMajor ? di > 0 : dj > 0

    // Enumerate every line of this family.
    //
    // A line is `minor = off + round(slope * major)`. Because `off` is an
    // integer and rounding a value plus an integer just shifts the result, that
    // map is a BIJECTION in `off` for every fixed `major` -- so sweeping `off`
    // across its range visits every cell in the grid exactly once, with no gaps
    // and no double-counting. That property is the whole reason for stepping
    // along the dominant axis; it is also easy to lose while refactoring, and
    // losing it leaves single texels with a horizon of zero, which read as
    // pinpricks of full sunlight inside a shadow.
    const drift = Math.round(slope * (n - 1))
    const offLo = -Math.max(drift, 0)
    const offHi = n - 1 + Math.max(-drift, 0)

    for (let off = offLo; off <= offHi; off++) {
      let len = 0
      for (let m = 0; m < n; m++) {
        // Walk the major axis in the direction of travel, so the samples come
        // out ordered near-to-far and the hull sweep can run backward over them
        // without a second reversal pass.
        const major = fwd ? m : n - 1 - m
        const minor = off + Math.round(slope * major)
        if (minor < 0 || minor > n - 1) continue
        const c = iMajor ? minor * n + major : major * n + minor
        px[len] = len * step
        py[len] = elev[c]
        pc[len] = c
        len++
      }
      if (len === 0) continue

      // --- the backward sweep, see the header ---
      let top = 0
      for (let k = len - 1; k >= 0; k--) {
        const xk = px[k]
        const yk = py[k]
        let best = 0 // nothing ahead: open sky

        while (top > 0) {
          const t0 = stack[top - 1]
          const s0 = (py[t0] - yk) / (px[t0] - xk)
          if (top === 1) {
            best = s0
            break
          }
          const t1 = stack[top - 2]
          const s1 = (py[t1] - yk) / (px[t1] - xk)
          if (s0 <= s1) {
            // t0 lies on or below the segment from k to t1, so it is off the
            // upper hull -- and it stays off for every point further back,
            // because k is in the candidate set for all of those. Discard it
            // permanently. This is the line that makes the algorithm linear.
            top--
            continue
          }
          best = s0
          break
        }

        // Downhill ground is not a shadow. Clamping at 0 rather than storing a
        // negative angle is what lets the byte encoding spend all 255 steps on
        // the half of the range that can actually occlude anything.
        const h = best > 0 ? Math.atan(best) : 0
        horizon[layer + pc[k]] = Math.round(h * ENCODE)

        // Cosine-weighted fraction of this azimuth's slice of sky visible above
        // the horizon angle. The Lambert integral has the closed form cos^2(h),
        // which is worth knowing: it makes the AO bake one cosine per texel per
        // azimuth rather than a second pass over the terrain.
        const ch = Math.cos(h)
        skyAcc[pc[k]] += ch * ch

        stack[top++] = k
      }
    }
  }

  const sky = new Uint8Array(size)
  for (let c = 0; c < size; c++) {
    // Floor at 0.16 rather than 0. A texel at the bottom of a slot canyon
    // genuinely sees almost no sky, but this is the ONLY ambient term the scene
    // has -- there is no bounce light and no GI -- so letting it reach zero
    // makes a crevice pure black rather than dark, and detail that goes to
    // black is detail that is gone.
    const v = 0.16 + 0.84 * (skyAcc[c] / AZIMUTHS)
    sky[c] = Math.round(Math.min(1, v) * 255)
  }

  return { horizon, sky }
}

/** Decode one baked angle back to radians. For the gate and for debugging. */
export const decodeHorizon = (byte) => (byte / 255) * (Math.PI / 2)
