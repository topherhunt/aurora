// Trace-only A/B switches over a layer's draw, so the perf battery can tell per-instance work from fill.

/** Draw half of `mesh`'s instances while `on`: a saving that tracks the count is vertex/instance work, one that does not is fill. */
export function halveDraw(mesh, on) {
  const base = (mesh.userData.drawHooks ??= { before: mesh.onBeforeRender, after: mesh.onAfterRender })
  let live = 0
  mesh.onBeforeRender = on ? (...a) => { base.before.apply(mesh, a); live = mesh.count; mesh.count = live >> 1 } : base.before
  mesh.onAfterRender = on ? (...a) => { mesh.count = live; base.after.apply(mesh, a) } : base.after
}

/** Compile `material` without its alpha-test discard while `off`, so the draw gets early-Z back; the cutout shows as full quads or solids. */
export function dropDiscard(material, off, alphaTest = 0.5) {
  material.alphaTest = off ? 0 : alphaTest
  material.needsUpdate = true
}
