// ---------------------------------------------------------------------------
// The gizmo-transform <-> lake-record mapping.
//
// A lake is not a mesh. It is `{x, z, y, rx, rz, rot, shape, carve, depth}` --
// a transformable PRIMITIVE (§18 "Lakes") -- and TransformControls only knows
// how to push an Object3D's position/quaternion/scale around. Something has to
// translate between the two, and that translation is the single fiddliest piece
// of the editor, so it lives here as a pure function that scripts/check-v2-edit.mjs
// can round-trip without a browser.
//
// THE BUG THIS FILE EXISTS TO PREVENT: an Object3D's `scale` is ABSOLUTE (1 is
// "as authored") while a lake's `rx`/`rz` are METRES. Reading scale straight
// into rx would make the first pixel of the first scale drag snap a 40 m lake to
// 1 m, because at that instant `scale.x` is 1.0. So the proxy object's scale is
// reset to 1 at every drag start, `base` is the lake AS OF THAT MOMENT, and the
// mapping multiplies: rx = base.rx * scale.x. Relative, not absolute.
//
// Y is the water level, so a translate drag on Y raises the lake surface (§18:
// "`y` on a lake is the water level"). scale.y is deliberately ignored -- a lake
// has no vertical extent to scale, `depth` is its own numeric field in the
// panel, and silently mapping scale.y onto depth would make the uniform-scale
// handle change the basin depth as a side effect of resizing the footprint.
// ---------------------------------------------------------------------------

// A drag can carry a scale handle through the object's centre and out the other
// side, which hands us a negative or zero factor. A lake with rx <= 0 divides by
// zero in the ellipse footprint test, so the drag is CLAMPED rather than
// allowed through -- this is a mouse gesture overshooting, not a violated
// invariant, and pinning it at half a metre is what every DCC tool does.
export const MIN_LAKE_RADIUS = 0.5

// Keep rot in (-PI, PI] so the panel's number field does not creep to 47 radians
// after a few spins. The in-range short circuit matters: it makes an untouched
// rotation bit-identical rather than 1e-16 off, which is what lets the identity
// round-trip assert exact equality.
function wrapPi(a) {
  if (a > -Math.PI && a <= Math.PI) return a
  const w = ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
  return w === -Math.PI ? Math.PI : w
}

/**
 * Where to put the proxy Object3D so the gizmo straddles this lake. Scale is
 * always 1: it is the drag's own delta, not the lake's size. See the header.
 */
export function gizmoFromLake(lake) {
  return {
    position: { x: lake.x, y: lake.y, z: lake.z },
    rotationY: lake.rot,
    scale: { x: 1, y: 1, z: 1 },
  }
}

/**
 * The proxy's transform mapped back onto a lake patch, relative to `base` (the
 * record as it stood when the drag started). Returns only the six fields a
 * gizmo can move; `shape`, `carve` and `depth` are panel fields and are left
 * alone so a drag cannot quietly change them.
 */
export function lakeFromGizmo(base, xform) {
  for (const k of ['x', 'y', 'z', 'rx', 'rz', 'rot']) {
    if (!Number.isFinite(base[k])) throw new Error(`lakeFromGizmo: base.${k} is ${base[k]}, not a number`)
  }
  if (!(base.rx > 0) || !(base.rz > 0)) throw new Error(`lakeFromGizmo: base radii must be positive, got ${base.rx} x ${base.rz}`)

  const { position, rotationY, scale } = xform
  for (const v of [position.x, position.y, position.z, rotationY, scale.x, scale.z]) {
    if (!Number.isFinite(v)) throw new Error('lakeFromGizmo: gizmo transform contains a non-finite number')
  }

  return {
    x: position.x,
    y: position.y,
    z: position.z,
    rot: wrapPi(rotationY),
    rx: Math.max(MIN_LAKE_RADIUS, base.rx * Math.abs(scale.x)),
    rz: Math.max(MIN_LAKE_RADIUS, base.rz * Math.abs(scale.z)),
  }
}
