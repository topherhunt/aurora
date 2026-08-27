import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Polylines -> one InstancedBufferGeometry of glow columns.
//
// ===========================================================================
// WHAT A CARD IS
// ===========================================================================
//
// One card is one COLUMN of glowing gas standing on one point of a traced
// contour. It is a single flat quad -- two triangles, four vertices -- that yaws
// about the world up axis to face the eye, and it is dead straight.
//
// It used to be subdivided vertically, and the reason it no longer is says
// something about the technique. The subdivision never resolved the brightness
// profile: that is per pixel in the fragment shader and is exact on one quad.
// It existed solely so the sideways fold and lean displacement could CURVE as
// the column climbed. That displacement is gone, because bending a card was
// working against the entire illusion -- the sheet here is assembled out of
// columns, and a bent column stops matching its neighbours, so the fold that was
// meant to make the sheet read as drapery instead made every card individually
// visible. The drapery now comes from where the contour runs on the ground,
// which is the trace's job and which it was already doing.
//
// So there is nothing left that varies horizontally with height, one quad is
// exact rather than an approximation, and the triangle count fell by four.
//
// ===========================================================================
// WHY THE HALF-WIDTH IS 1 / (2 |grad phi|) AND NOT A TUNED NUMBER
// ===========================================================================
//
// The channels are contours of a potential at unit spacing, so the distance on
// the ground from one channel to the next is exactly 1 / |grad phi|, and half of
// that is where this channel's territory ends and its neighbour's begins.
// Baking that distance into the instance rather than a chosen width is what
// reproduces the field's "crowd and thin" behaviour EXACTLY rather than
// imitating it: where the potential steepens, the contours bunch up and the
// cards narrow by the same factor, automatically, with no term controlling it.
//
// The two clamps are both load-bearing and for different reasons. The floor
// stops a channel crossing a very steep patch from collapsing to a sliver
// thinner than a pixel, which aliases into a crawling dotted line. The ceiling
// is not cosmetic at all: where the potential flattens out the gradient goes to
// zero and this expression goes to infinity, so without a ceiling one unlucky
// card swallows the whole sky.
//
// The floor has a second job that took a picket fence to notice. A card is only
// as wide as its channel, and below the spacing floor a few lines down the
// spacing STOPS shrinking with the channel while the card keeps shrinking with
// it -- so the narrowest channels are the ones whose cards stop overlapping,
// and they are also the ones nobody thinks to check, because the obvious place
// to look for a sampling problem is the widest thing on the screen. The two
// floors have to be read together: widthMinKm wants to be about twice
// cardSpacingKm, and params.js has the algebra.
//
// ===========================================================================
// KM_TO_WORLD IS A DEPTH BUFFER CONVENIENCE AND NOTHING ELSE
// ===========================================================================
//
// The apparent size of the aurora depends only on the RATIO of a column's
// altitude to its plan distance, and this constant scales both, so it cancels
// out of everything the eye can see. What it does change is where the geometry
// falls between the near and far planes: the backdrop cap sits at 1500 units and
// the camera's far plane at 40,000, so this is chosen to put the nearest column
// comfortably outside the cap and the furthest one comfortably inside the far
// plane. `src/aurora.js` uses 45 for the same reason against a different far
// plane, and the two numbers do not need to agree.
// ---------------------------------------------------------------------------

export const KM_TO_WORLD = 22

/**
 * Build the instanced geometry for a traced contour set.
 *
 * `lines` is the `lines` array from traceContours. Returns
 *   { geometry, cards, tris, dropped }
 * where `dropped` counts columns culled by the draw radius, which is worth
 * surfacing because a draw radius set below the belt distance silently deletes
 * the aurora and looks exactly like a tuning that has gone dark.
 */
export function buildCards(lines, P) {
  const maxSq = P.maxDistKm * P.maxDistKm

  const plan = []
  const tan = []
  const card = []
  let dropped = 0

  for (let c = 0; c < lines.length; c++) {
    const line = lines[c]
    const n = line.arc.length
    // Two contour components of the same level are separate arcs and should not
    // pulse in unison, so the component index perturbs the id. The offset is
    // deliberately not an integer: `id` indexes the gate noise, and integer ids
    // would land two components of adjacent levels on the same lattice point.
    const id = line.level + c * 0.3117
    let nextArc = -Infinity

    for (let i = 0; i < n; i++) {
      const x = line.pts[i * 2]
      const z = line.pts[i * 2 + 1]
      if (x * x + z * z > maxSq) { dropped++; continue }
      if (line.arc[i] < nextArc) continue

      // Tangent from the neighbours rather than from the forward difference, so
      // a card sits square to the curve through it instead of leaning toward the
      // next one. On a closed ring the ends wrap; on an open arc they clamp.
      let a = i - 1, b = i + 1
      if (a < 0) a = line.closed ? n - 2 : 0
      if (b > n - 1) b = line.closed ? 1 : n - 1
      let tx = line.pts[b * 2] - line.pts[a * 2]
      let tz = line.pts[b * 2 + 1] - line.pts[a * 2 + 1]
      const tl = Math.hypot(tx, tz)
      if (tl < 1e-6) { dropped++; continue }
      tx /= tl; tz /= tl

      const g = line.grad[i]
      // A gradient of zero is a genuine feature of the field (it happens at
      // every extremum), so this is a real branch and not a defensive one: the
      // ceiling is the answer there, and it is the same answer the clamp below
      // would give.
      const halfKm = g > 1e-9
        ? Math.min(P.widthMaxKm, Math.max(P.widthMinKm, 1 / (2 * g)))
        : P.widthMaxKm

      // ---- Spacing proportional to width, which is what makes overdraw a
      // CONSTANT instead of a consequence of the field.
      //
      // At a fixed spacing the overlap along a channel is 2 * halfKm * reach /
      // spacing, and halfKm varies fifteenfold across the sky, so the widest
      // channels were being sampled twelve deep while the narrowest got two.
      // The twelve buys nothing: a wide channel is wide precisely because the
      // potential is flat there, so it has no fine along-channel detail for the
      // extra cards to carry. Spacing at a fraction of the width instead makes
      // the overlap 2 * reach / spacingFrac, which is a number this file knows
      // and the field cannot change.
      //
      // The floor is what keeps a narrow channel from being sampled so finely
      // that it costs more than it is worth, and it is the knob to reach for
      // when the triangle count needs to come down.
      nextArc = line.arc[i] + Math.max(P.cardSpacingKm, halfKm * P.spacingFrac)

      plan.push(x, z)
      tan.push(tx, tz)
      // No per-card random rides along here, and that absence is load-bearing:
      // a card is a SAMPLE of a continuous curtain, so anything keyed on which
      // sample it is makes neighbours disagree about a quantity the curtain
      // holds continuously. At tens of kilometres between cards that reads as a
      // picket fence, which is what it did.
      card.push(halfKm, id, line.arc[i])
    }
  }

  const count = plan.length / 2

  // ---- the base quad, shared by every instance -----------------------------
  // x is -1..1 across the card and y is 0..1 up it; the vertex shader turns
  // those into a world position. Four vertices and two triangles, written out
  // literally rather than generated, because a loop that always runs once is a
  // loop that invites somebody to make it run twice.
  const verts = new Float32Array([
    -1, 0, 0,
     1, 0, 0,
    -1, 1, 0,
     1, 1, 0,
  ])
  const index = new Uint16Array([0, 1, 3, 0, 3, 2])

  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(verts, 3))
  geometry.setIndex(new THREE.BufferAttribute(index, 1))
  geometry.setAttribute('iPlan', new THREE.InstancedBufferAttribute(new Float32Array(plan), 2))
  geometry.setAttribute('iTan', new THREE.InstancedBufferAttribute(new Float32Array(tan), 2))
  geometry.setAttribute('iCard', new THREE.InstancedBufferAttribute(new Float32Array(card), 3))
  geometry.instanceCount = count

  // The mesh is sky-locked to the eye and covers most of the upper hemisphere,
  // so a bounding sphere is never going to reject it and computing one from the
  // instance data would only be a per-rebuild cost with no per-frame payoff.
  // Given explicitly rather than left to three.js, which would derive it from
  // the base quad alone and cull the entire sky the moment the eye turned.
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, 0, 0),
    Math.hypot(P.maxDistKm, P.altHigh) * KM_TO_WORLD,
  )

  return { geometry, cards: count, tris: count * 2, dropped }
}
