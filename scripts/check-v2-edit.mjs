// Gate for the §18 v2 editing tools (src/v2/edit/).
//
// Most of that directory is DOM and three.js and cannot be exercised without a
// browser -- a TransformControls drag, a pointer event, a panel repaint. So the
// three pieces that CAN go wrong silently and CAN be tested were deliberately
// written as plain functions in their own modules, and this is what tests them:
//
//   pick.js          the terrain raymarch, against an analytic field
//   lake-transform.js  the gizmo-transform -> lake-record mapping
//   history.js       the bounded undo stack
//   restore.js       replaying a snapshot into a live Layers
//   handles.js       re-resolving a point selection across a structural edit
//
// Sections 4 and 5 run against the REAL src/v2/layers/, which is three-free by
// constraint 3 and therefore imports here. That matters: a stub would test this
// gate's idea of the layer API rather than the layer API, and the six places
// that idea was already wrong are the reason the section was rewritten.
//
// The lake mapping is the one that earns its section. Reading an Object3D's
// ABSOLUTE scale into a lake's rx/rz in METRES teleports the lake to 1 m across
// on the first pixel of the first scale drag, and it is invisible in code
// review because the wrong version is shorter than the right one.
//
//   node scripts/check-v2-edit.mjs

import { fileURLToPath } from 'node:url'

import { WORLD_SIZE } from '../src/v2/config.js'
import { raymarchGround } from '../src/v2/edit/pick.js'
import { gizmoFromLake, lakeFromGizmo, MIN_LAKE_RADIUS } from '../src/v2/edit/lake-transform.js'
import { History } from '../src/v2/edit/history.js'
import { restoreLayers, emptyDoc } from '../src/v2/edit/restore.js'
import { rebindIndex, pathPointPos, snowPointPos } from '../src/v2/edit/handles.js'
import { splitPoint } from '../src/v2/edit/split.js'
import { Layers } from '../src/v2/layers/layers.js'
import { livePoints } from '../src/v2/layers/paths.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const near = (a, b, tol) => Math.abs(a - b) <= tol

// --- section 1: the raymarch -------------------------------------------------
//
// Two sines and a fine ripple, so the surface has both a long wavelength the
// coarse march strides over and a short one the near-field step has to resolve.

function sectionRaymarch() {
  console.log('\nraymarch against an analytic field')

  const field = {
    calls: 0,
    heightAt(x, z) {
      this.calls++
      return 40 * Math.sin(x * 0.01) + 25 * Math.cos(z * 0.013) + 6 * Math.sin(x * 0.21 + z * 0.17)
    },
  }

  // Aim from a fixed eye at a spread of headings and depression angles.
  const origin = { x: -120, y: 160, z: 65 }
  // Worst missed crossing, by range band. The step is proportional to range, so
  // the ability to tunnel through a ripple crest is too: reporting one number
  // for the whole ray would hide where the schedule is exact and where it is
  // approximate. Under 50 m the step is at most 50 cm and nothing in a field
  // like this can hide inside it; past that a grazing ray can clip a crest.
  const BANDS = [50, 500, Infinity]
  const early = [0, 0, 0]
  let worstOffRay = 0
  let worstResidual = 0
  let hits = 0
  let marchCalls = 0

  for (let i = 0; i < 48; i++) {
    const yaw = (i / 48) * Math.PI * 2
    const pitch = -0.05 - (i % 6) * 0.12
    const dir = { x: Math.cos(pitch) * Math.cos(yaw), y: Math.sin(pitch), z: Math.cos(pitch) * Math.sin(yaw) }
    field.calls = 0
    const hit = raymarchGround(field, origin, dir)
    marchCalls += field.calls
    if (!hit) continue
    hits++

    // ON THE SURFACE: the returned y is the field at the returned xz by
    // construction, so what this really measures is that the point is on the RAY
    // too -- perpendicular distance from the line, which is where a bisection
    // that converged to the wrong bracket would show up.
    const t = (hit.x - origin.x) * dir.x + (hit.y - origin.y) * dir.y + (hit.z - origin.z) * dir.z
    const off = Math.hypot(hit.x - (origin.x + dir.x * t), hit.y - (origin.y + dir.y * t), hit.z - (origin.z + dir.z * t))
    worstOffRay = Math.max(worstOffRay, off)
    worstResidual = Math.max(worstResidual, Math.abs(hit.y - field.heightAt(hit.x, hit.z)))

    // FIRST crossing, not just any crossing: walk the ray up to the hit and make
    // sure it never dipped under the field on the way. Sampled at 5 cm, the
    // march's own near-field step, so the walk cannot miss what the march caught.
    const steps = Math.ceil(t / 0.05)
    for (let k = 1; k < steps; k++) {
      const s = (t * k) / steps
      const below = field.heightAt(origin.x + dir.x * s, origin.z + dir.z * s) - (origin.y + dir.y * s)
      const band = BANDS.findIndex((edge) => s < edge)
      early[band] = Math.max(early[band], below)
    }
  }

  check(hits >= 40, 'downward rays find the ground', `${hits}/48 hit`)
  check(worstOffRay < 0.01, 'the hit lies on the ray to under 1 cm', `worst ${worstOffRay.toExponential(2)} m off the line`)
  check(worstResidual < 0.01, 'the hit lies on the surface to under 1 cm', `worst ${worstResidual.toExponential(2)} m`)
  check(
    early[0] < 0.01,
    'inside 50 m the hit is the FIRST crossing, to under 1 cm',
    `worst prior penetration ${early[0].toExponential(2)} m`
  )
  // Measured, not asserted away: pick.js's header says the far field can tunnel
  // a crest and this is the number behind that sentence.
  console.log(`        worst missed crossing by range: <50 m ${early[0].toExponential(1)} m, 50-500 m ${early[1].toFixed(2)} m, >500 m ${early[2].toFixed(2)} m`)
  console.log(`        ~${Math.round(marchCalls / 48)} heightAt calls per pick`)

  // The march has to reach the far side of the world, and the world size has
  // moved twice mid-build. A ray that lands 9 km out must still find ground.
  {
    const flat = { heightAt: () => 0 }
    const far = raymarchGround(flat, { x: 0, y: 900, z: 0 }, { x: Math.sqrt(0.99), y: -0.1, z: 0 })
    check(far !== null, 'the default range reaches the far side of the world', far ? `hit at ${Math.round(far.x)} m out, world diagonal ${Math.round(Math.hypot(WORLD_SIZE, WORLD_SIZE))} m` : 'MISSED -- maxDist is shorter than the world')
  }

  // Misses. Both of them return null rather than a plausible-looking point.
  check(raymarchGround(field, origin, { x: 0, y: 1, z: 0 }) === null, 'a ray fired at the sky returns null')
  check(
    raymarchGround(field, { x: 0, y: -400, z: 0 }, { x: 0, y: -1, z: 0 }) === null,
    'a ray starting below the surface returns null'
  )
  // A shallow ray over a flat-ish patch runs out of world rather than wrapping.
  check(
    raymarchGround(field, { x: 0, y: 4000, z: 0 }, { x: 1, y: -0.0001, z: 0 }) === null,
    'a ray that skims past the world without touching it returns null'
  )

  // THE 6 CM CLAIM. A 30 cm-wide bump 3.5 m away -- the scale v2 resolves and v1
  // does not -- and the same pick with v1's 1 m near step, which strides over it.
  {
    const bump = { heightAt: (x) => Math.exp(-(((x - 3.5) / 0.15) ** 2)) }
    const eye = { x: 0, y: 0.9, z: 0 }
    const along = { x: 1, y: 0, z: 0 }
    const fine = raymarchGround(bump, eye, along)
    const coarse = raymarchGround(bump, eye, along, { nearStep: 1 })
    check(fine !== null && near(fine.x, 3.42, 0.12), 'a 30 cm feature at 3.5 m is not stepped over', fine ? `hit at x ${fine.x.toFixed(3)}` : 'MISSED')
    check(coarse === null, "and v1's 1 m step DOES miss it, so this check measures what it claims", coarse ? `hit at x ${coarse.x.toFixed(3)}` : 'missed as expected')
  }
}

// --- section 2: gizmo transform -> lake record -------------------------------

function sectionLake() {
  console.log('\ngizmo transform -> lake record')

  const base = { id: 'l3', x: 12, y: 80, z: -40, rx: 55, rz: 33, rot: 0.4, shape: 0, carve: 1, depth: 8 }

  // IDENTITY. The proxy sits where the lake is and has not been dragged, so the
  // record must come back bit-identical. This is the assertion that fails when
  // scale is read absolutely: rx would come back 1.
  {
    const patch = lakeFromGizmo(base, gizmoFromLake(base))
    const same = ['x', 'y', 'z', 'rx', 'rz', 'rot'].every((k) => patch[k] === base[k])
    check(same, 'an undragged gizmo round-trips the record unchanged', JSON.stringify(patch))
  }

  // KNOWN TRANSFORM. Translate to (100, 90, -7), rotate to 1 rad, scale x2 in X
  // and x0.5 in Z.
  {
    const patch = lakeFromGizmo(base, {
      position: { x: 100, y: 90, z: -7 },
      rotationY: 1,
      scale: { x: 2, y: 1, z: 0.5 },
    })
    check(patch.x === 100 && patch.y === 90 && patch.z === -7, 'translate lands on x/y/z (y is the water level)', `${patch.x}, ${patch.y}, ${patch.z}`)
    check(patch.rot === 1, 'rotate lands on rot')
    check(near(patch.rx, 110, 1e-12) && near(patch.rz, 16.5, 1e-12), 'scale is RELATIVE to the current radii', `${patch.rx} x ${patch.rz} from ${base.rx} x ${base.rz}`)
  }

  // TWO SUCCESSIVE DRAGS, which is where an absolute reading looks correct once
  // and then stops. Doubling twice must reach 4x, not 2x.
  {
    const one = lakeFromGizmo(base, { position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: { x: 2, y: 1, z: 2 } })
    const two = lakeFromGizmo({ ...base, ...one }, { position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: { x: 2, y: 1, z: 2 } })
    check(near(two.rx, base.rx * 4, 1e-12), 'two doubling drags compound to 4x', `${base.rx} -> ${one.rx} -> ${two.rx}`)
  }

  // A scale handle dragged through the centre and out the other side.
  {
    const flipped = lakeFromGizmo(base, { position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: { x: -1, y: 1, z: 0 } })
    check(flipped.rx === base.rx, 'a negative scale mirrors rather than inverting the radius', `${flipped.rx}`)
    check(flipped.rz === MIN_LAKE_RADIUS, 'a zero scale clamps instead of producing a degenerate lake', `${flipped.rz} m`)
  }

  // Spinning the rotate ring several turns must not leave rot at 20 radians.
  {
    const spun = lakeFromGizmo(base, { position: { x: 0, y: 0, z: 0 }, rotationY: 7.5, scale: { x: 1, y: 1, z: 1 } })
    check(spun.rot > -Math.PI && spun.rot <= Math.PI, 'rot is wrapped into (-PI, PI]', `7.5 rad -> ${spun.rot.toFixed(4)}`)
    check(near(spun.rot, 7.5 - 2 * Math.PI, 1e-12), 'and the wrap is the same angle', `${spun.rot.toFixed(6)} vs ${(7.5 - 2 * Math.PI).toFixed(6)}`)
  }

  // Bad input is refused rather than written into the document.
  {
    let threw = false
    try {
      lakeFromGizmo({ ...base, rx: 0 }, gizmoFromLake(base))
    } catch {
      threw = true
    }
    check(threw, 'a base with a zero radius throws instead of dividing by it')
  }
}

// --- section 3: the undo stack -----------------------------------------------

function sectionHistory() {
  console.log('\nundo stack')

  const h = new History(64)
  h.reset('a')
  check(!h.canUndo && !h.canRedo, 'a freshly loaded world has nothing to undo or redo')

  h.push('b')
  h.push('c')
  check(h.canUndo && !h.canRedo, 'after two edits, undo is available and redo is not')
  check(h.undo() === 'b' && h.undo() === 'a', 'undo walks back through every state')
  check(h.undo() === null, 'undo past the origin returns null rather than wrapping')
  check(h.redo() === 'b' && h.redo() === 'c', 'redo walks forward again')
  check(h.redo() === null, 'redo past the head returns null')

  // BRANCHING. Editing after an undo drops the redo tail: the future it
  // described no longer follows from the present.
  h.undo() // -> b
  h.push('d')
  check(!h.canRedo, 'an edit after an undo drops the redo tail')
  check(h.undo() === 'b' && h.undo() === 'a', 'and the surviving history is the branch that was kept')

  // BOUNDED. 200 pushes into a 64-deep stack keeps the 64 most recent.
  const b = new History(64)
  b.reset('s0')
  for (let i = 1; i <= 200; i++) b.push(`s${i}`)
  check(b.size === 64, 'the stack stays bounded under a long session', `${b.size} entries after 201 states`)
  let steps = 0
  while (b.undo() !== null) steps++
  check(steps === 63, 'and every entry it kept is reachable by undo', `${steps} undos available`)

  let threw = false
  try {
    new History(1)
  } catch {
    threw = true
  }
  check(threw, 'a limit with no room for an undo is refused at construction')
}

// A six-point spline that stays inside the +/-4096 m world: 210 m of x and
// 140 m of z per step, so the whole thing is about 1 km long -- a real river,
// not a fixture at the world edge that would pass here and clamp in the editor.
const mkPts = (n, ox) =>
  Array.from({ length: n }, (_, i) => [ox + i * 210, 100 - i * 3, i * 140 - 300, 8 - i * 0.4])

function fixtureLayers() {
  const layers = new Layers()
  // Band has no setter (see restore.js); base does, and it marks the world dirty.
  layers.snow.band = 38
  layers.setSnowBase(210)
  layers.addSnowPoint(-1200, 400, 55, 900)
  layers.addSnowPoint(2100, -800, -30, 600)
  layers.addSnowPoint(120, 60, 12, 350)
  layers.addLake({ x: 0, z: 0, y: 120, rx: 80, rz: 55, rot: 0.4, shape: 0, carve: 1, depth: 8 })
  layers.addLake({ x: 900, z: -420, y: 96, rx: 40, rz: 40, rot: 0, shape: 1, carve: 1, depth: 5 })
  layers.addPath({ kind: 'river', pts: mkPts(6, -2000) })
  layers.addPath({ kind: 'river', pts: mkPts(6, 1400) })
  layers.addPath({ kind: 'road', pts: mkPts(5, -400) })
  return layers
}

function sectionRestore() {
  console.log('\nsnapshot -> live Layers')

  const layers = fixtureLayers()
  const snapshot = JSON.stringify(layers.serialize())
  // §18's compactness claim, measured rather than asserted. If this ever reaches
  // hundreds of kB, something baked has leaked into the stored representation.
  console.log(`        8 authored objects (3 snow points, 2 lakes, 2 rivers, 1 road) serialise to ${snapshot.length} B`)
  check(snapshot.length < 8192, 'a typical authored world is kilobytes, not megabytes', `${snapshot.length} B`)

  // The document has to survive doc.js's own validator, not just a round trip
  // through code that wrote it: this is the form that gets committed as
  // world/layers.json and read back by a boot that never saw this process.
  let reloaded = null
  try {
    reloaded = Layers.deserialize(JSON.parse(snapshot))
  } catch (e) {
    check(false, 'the serialised document passes validate() on a cold load', e.message)
  }
  if (reloaded !== null) {
    check(JSON.stringify(reloaded.serialize()) === snapshot, 'the serialised document reloads into an identical world')
  }

  // Wreck the world, then put it back.
  layers.removeLake('l2')
  layers.moveSnowPoint(0, 3900, -3900)
  layers.removePathPoint('r1', 2)
  layers.addPath({ kind: 'road', pts: mkPts(3, 1500) })
  const epochBefore = layers.epoch
  layers.takeDirtyRect()

  restoreLayers(layers, JSON.parse(snapshot))
  check(JSON.stringify(layers.serialize()) === snapshot, 'a replayed snapshot reproduces the document exactly')
  check(layers.epoch > epochBefore, 'the replay goes through the mutation API and bumps the epoch', `${epochBefore} -> ${layers.epoch}`)
  check(layers.takeDirtyRect() !== null, 'and leaves a dirty rect for the remesh')
  // IdAllocator mints l3 next, having seen l1 and l2 -- so a replay that did NOT
  // carry the snapshot's ids would leave these two lakes called l3 and l4, and
  // every selection, every undo entry and every line of the committed
  // layers.json diff would name an object that no longer exists.
  const ids = [...layers.lakes.lakes.keys()].join(',')
  check(ids === 'l1,l2', 'ids survive the replay, so a selection and a git diff both stay stable', ids)
  const pathIds = [...layers.paths.paths.keys()].join(',')
  check(pathIds === 'r1,r2,d1', 'and so do river and road ids, including the road that was added and undone', pathIds)

  restoreLayers(layers, emptyDoc(210, 38))
  const empty = layers.serialize()
  check(
    empty.snow.points.length === 0 && empty.lakes.length === 0 && empty.rivers.length === 0 && empty.roads.length === 0,
    'restoring the empty document empties every layer'
  )

  let threw = false
  try {
    restoreLayers(layers, { nope: true })
  } catch {
    threw = true
  }
  check(threw, 'a document that is not a v2 world is refused rather than half-applied')

  // The snow line is metres above sea level and the heightmap bake decides what
  // those metres are, so an empty document cannot invent one. See emptyDoc().
  let baseThrew = false
  try {
    emptyDoc()
  } catch {
    baseThrew = true
  }
  check(baseThrew, 'an empty document refuses to default the snow line to a stale elevation')
}

// --- section 5: a selection handle across a structural edit ------------------
//
// The failure this is here to catch does not throw and does not look wrong on
// screen: delete a middle control point while a later one is selected, and if
// the list compacted, the selection silently becomes its neighbour. The gizmo is
// still drawn on a point, the panel still shows a row, and the next drag moves
// something the author was not pointing at.
//
// Both layers tombstone today, so a cached index would in fact survive a delete.
// The checks below do not assume that: they assert the WORLD POSITION a handle
// resolves to, which is the property that actually matters, and they run the
// same rebind against a compacting list to show it is not leaning on the
// current convention. insertPoint still renumbers under any convention.
function sectionHandles() {
  console.log('\nselection handles across a structural edit')

  const layers = fixtureLayers()
  const rec = layers.paths.paths.get('r1')
  const held = pathPointPos(rec.pts[4])
  const heldXYZ = [...rec.pts[4]]

  layers.removePathPoint('r1', 2)
  const after = rebindIndex(rec.pts, held, pathPointPos)
  check(after !== null, 'a handle on a later point survives deleting a middle one', `#4 -> #${after}`)
  check(
    after !== null && rec.pts[after][0] === heldXYZ[0] && rec.pts[after][2] === heldXYZ[2],
    'and still addresses the same world position',
    after === null ? 'lost' : `${rec.pts[after][0]}, ${rec.pts[after][2]}`
  )
  check(livePoints(rec).length === 5, 'the path really did lose a point', `${livePoints(rec).length} live of ${rec.pts.length} slots`)

  // The point that WAS deleted resolves to nothing, which is the honest answer
  // and the one the editor needs: it falls back to selecting the whole path.
  check(rebindIndex(rec.pts, { x: -2000 + 2 * 210, z: 2 * 140 - 300 }, pathPointPos) === null, 'the deleted point itself resolves to nothing rather than to its neighbour')

  // A mid-insert renumbers under every convention -- the order IS the curve.
  const beforeInsert = pathPointPos(rec.pts[4])
  layers.insertPathPoint('r1', 0, -1900, 98, -230, 7)
  const shifted = rebindIndex(rec.pts, beforeInsert, pathPointPos)
  check(shifted === 5, 'an insert below the handle shifts it, and the rebind follows', `#4 -> #${shifted}`)

  // Snow points: same rebind, different storage shape ({x, z, ...} objects).
  const snowHeld = snowPointPos(layers.snow.points[2])
  layers.removeSnowPoint(1)
  const snowAfter = rebindIndex(layers.snow.points, snowHeld, snowPointPos)
  check(snowAfter === 2 && layers.snow.points[snowAfter].x === snowHeld.x, 'a snow handle survives deleting an earlier snow point', `#2 -> #${snowAfter}`)
  check(rebindIndex(layers.snow.points, { x: 2100, z: -800 }, snowPointPos) === null, 'and the removed snow point resolves to nothing')

  // The same rebind against a list that COMPACTS. Nothing in the layers does
  // this now; the point is that the editor would still be correct if one did.
  const compacting = mkPts(6, 0).map((p) => [...p])
  const wantCompact = pathPointPos(compacting[4])
  compacting.splice(2, 1)
  const idx = rebindIndex(compacting, wantCompact, pathPointPos)
  check(idx === 3 && compacting[idx][0] === wantCompact.x, 'the same rebind is correct against a list that splices instead', `#4 -> #${idx}`)
}

// --- section 6: splitting a spline segment -----------------------------------
//
// The right-click "split before / split after" arithmetic. What makes it worth
// a section is that BOTH ends of it are silent when wrong: a dir sign error
// splits the segment on the wrong side, which looks fine until you notice the
// point landed where you did not click, and averaging the wrong pair of widths
// steps the bank at a point nobody moved.

function sectionSplit() {
  console.log('\nsplitting a spline segment')

  const ground = (x, z) => 100 + x * 0.01 - z * 0.02
  // Deliberately NOT evenly spaced and NOT of one width: an even ladder cannot
  // tell a midpoint apart from a neighbour's position, and equal widths cannot
  // tell a mean apart from a copy.
  const pts = [
    [0, 50, 0, 4],
    [100, 70, 40, 10],
    [400, 60, 240, 6],
  ]

  const mid = splitPoint(pts, 0, 1, ground)
  check(
    mid[0] === 50 && mid[1] === 60 && mid[2] === 20 && mid[3] === 7,
    'split-after lands on the midpoint of the pair, width averaged',
    `[${mid.join(', ')}]`
  )

  const back = splitPoint(pts, 2, -1, ground)
  check(
    back[0] === 250 && back[2] === 140 && back[3] === 8,
    'split-before halves the segment BEFORE the point, not after it',
    `[${back.join(', ')}]`
  )

  // Equidistance is the user's word for it, and it is a property worth asserting
  // directly rather than inferring from three coordinates being right.
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  check(near(d(pts[1], mid), d(mid, pts[0]), 1e-9), 'and the new point is equidistant from both', `${d(pts[0], mid).toFixed(3)} m each way`)

  const ext = splitPoint(pts, 2, 1, ground)
  check(
    ext[0] === 550 && ext[2] === 340 && ext[3] === 6,
    'past the last point the path EXTENDS by half the last segment, keeping its width',
    `[${ext.join(', ')}]`
  )
  check(ext[1] === ground(ext[0], ext[2]), 'and the extension takes Y from the ground, not from the slope it was on', `${ext[1].toFixed(2)} m`)
  // The slope from p1 to p2 is falling 10 m over 300; continued, it would put
  // the new point at 55 m while the ground there is 98.7. A river cannot be
  // authored 44 m in the air by accident.
  check(ext[1] !== 55, 'specifically NOT the segment slope continued', `slope would say 55 m`)

  const head = splitPoint(pts, 0, -1, ground)
  check(head[0] === -50 && head[2] === -20 && head[3] === 4, 'the same extension works off the head of the path', `[${head.join(', ')}]`)

  const solo = splitPoint([[10, 5, -10, 3]], 0, 1, ground)
  check(solo[0] === 22 && solo[2] === -10, 'a one-point path steps sideways by four widths -- there is no direction to extend along', `[${solo.join(', ')}]`)

  for (const [label, fn] of [
    ['an out-of-range index', () => splitPoint(pts, 3, 1, ground)],
    ['a dir that is not +/-1', () => splitPoint(pts, 0, 2, ground)],
    ['an empty point list', () => splitPoint([], 0, 1, ground)],
    ['a missing groundAt', () => splitPoint(pts, 0, 1, null)],
  ]) {
    let threw = false
    try {
      fn()
    } catch {
      threw = true
    }
    check(threw, `${label} throws rather than returning a plausible point`)
  }
}

export async function run() {
  console.log('\n=== v2 editing tools ===')
  sectionRaymarch()
  sectionLake()
  sectionHistory()
  sectionRestore()
  sectionHandles()
  sectionSplit()
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  // THROWS rather than returning the count, because check-v2.mjs's aggregator
  // only catches: it calls `await mod.run()` and ignores what comes back, so a
  // section that returns its failure count reports FAIL lines and then lets the
  // whole gate print ALL SECTIONS PASSED. The count is still returned for a
  // caller that wants it, on the path where there is nothing to return but 0.
  if (failures > 0) throw new Error(`check-v2-edit: ${failures} check(s) failed`)
  return failures
}

// argv[1] is undefined under `node -e`, and comparing it to a string is false
// rather than a crash -- which is what an aggregator importing run() needs.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run()
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
