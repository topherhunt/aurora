// Node-side gates for the solid-tree pipeline (tools/trees/v9/, src/mesh/paint.js).
//
//   node scripts/check-tree-v9.mjs
//
// SPENDS NOTHING AND MAKES NO NETWORK CALL. Everything here is pure: the prompt
// builder, the species table, the price arithmetic, the one path computation,
// and the painting maths. Same reasoning as check-creatures.mjs -- this
// pipeline's failure modes cost real money, so the parts that can be checked
// for free are checked on every `npm run check`.
//
//   A TREE ID REACHES THE FILESYSTEM. `id` arrives from a query string and is
//   concatenated into a working path, on a dev server that binds to the LAN.
//   `../` there is an arbitrary file write, so the validator is a security
//   boundary and not tidiness.
//
//   THE PROMPT GOES BACK TO ASKING FOR A PHOTOGRAPH. It did twice. A picture of
//   dense foliage carries no depth between the leaves, so the reconstruction has
//   nothing to be right about and the better the picture the worse the mesh --
//   40 credits of contorted lollipops that nothing downstream notices, because
//   the picture is lovely. The prompt asks for a low-poly MODEL: big flat
//   facets, foliage as a few smooth masses, no leaves, no twigs, closed.
//
//   THE TRUNK GOES MISSING. The paint step can only paint faces that exist, so a
//   canopy swallowing the trunk has no bark region in it. Every species says
//   where its own lowest branches start; one shared "a clear length of bare
//   trunk" gave the pine a bare pole halfway up itself.
//
//   THE PRICE DRIFTS FROM THE REQUEST. The bench prints a cost on a button
//   before anyone clicks it, out of the same table the request is built from.
//
//   THE CYLINDRICAL PROJECTION STOPS TILING. Bark closes on itself around a
//   trunk only if the number of repeats is a whole number, and a face that
//   straddles atan2's branch cut stretches the entire texture backwards across
//   one triangle. Both are invisible in a unit test of "did it produce UVs" and
//   both are the only reasons this projection is written by hand.
//
//   THE FLOOD FILL GOES BACK TO MEASURING AGAINST THE SEED. Against the seed a
//   40 deg cone stops a quarter of the way round a trunk; against the neighbour
//   walked from, it goes all the way round and still stops at the crown. That
//   difference is what makes one click select a trunk, and it is a one-word edit
//   to lose.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TREE_SPECIES, buildTreePrompt, speciesById } from '../tools/trees/v9/tree-species.mjs'
import { workDir } from '../tools/trees/v9/workspace.mjs'
import { estimateCredits } from '../tools/creatures/tripo.mjs'
import { IMAGE_MODELS, requireImageModel } from '../tools/characters/openrouter.mjs'
import {
  boundsDiagonal, buildFaceAdjacency, buildPaintedMesh, faceCount, faceFrames,
  facesInSphere, floodFill, groundAndScale, projectUvs, unweld,
} from '../src/mesh/paint.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const throws = (fn) => { try { fn(); return false } catch { return true } }

// --- the id validator --------------------------------------------------------

console.log('\ntree id validation')
check(throws(() => workDir('../../etc')), 'workDir rejects a traversal')
check(throws(() => workDir('oak/../../x')), 'workDir rejects a slash')
check(throws(() => workDir('')), 'workDir rejects an empty id')
check(throws(() => workDir('V9-Oak')), 'workDir rejects capitals (case-folding filesystems make two ids one directory)')
check(!throws(() => workDir('v9-oak')), 'workDir accepts a roster id')
check(workDir('v9-oak').startsWith(path.join(ROOT, 'tools/trees/v9/work')), 'workDir lands under the work directory')

// --- the prompt --------------------------------------------------------------

console.log('\nimage prompt')
check(throws(() => buildTreePrompt({})), 'a prompt with no text throws -- there is nothing left to fall back on')
check(throws(() => buildTreePrompt({ styleNote: 'painterly' })), 'and a style note alone is not a tree')

const prompt = buildTreePrompt(TREE_SPECIES[0])
const lower = prompt.toLowerCase()
check(prompt.includes(TREE_SPECIES[0].prompt), 'the species prompt is in the built prompt verbatim -- one field, edited in one place')
check(/low-poly/.test(lower) && /flat polygon facets/.test(lower),
  'the picture is ordered as a low-poly MODEL, not a photograph: a photo of dense foliage has no depth between the leaves to reconstruct')
check(/no individual leaves/.test(lower) && /no twigs/.test(lower),
  'and the structure that reconstructs as lollipops is ruled out by name')
check(!/photorealistic|photograph of/.test(lower), 'nothing asks for a photograph any more -- two passes of that produced better pictures and worse meshes')
check(/one closed solid object/.test(lower) && /watertight/.test(lower),
  'the model is ordered closed, which is the whole reason this pipeline exists (alpha-tested foliage costs the draw its low-res Z)')
check(/asymmetric/.test(lower), 'irregularity is ordered -- a mirror-symmetrical tree is the surest tell that a mesh was generated')
check(/plain flat mid-grey background/.test(lower), 'the background is plain and neutral')
check(!/magenta|chroma|green screen/.test(lower), 'no chroma key -- it bleeds its own colour into the reconstruction')
check(/no cast shadow/.test(lower) && /even flat lighting/.test(lower),
  'the light is flat and unshadowed, so nothing bakes into base colour and fights src/lighting.js')
check(/the foot of the trunk is well above the bottom edge/.test(lower),
  'the framing is pinned with a margin -- asked for loosely, the tree came back with its trunk cropped at the frame edge')

// The pine is the species every pass gets wrong, twice over: a spindly trunk
// running halfway up, under a crown of evenly stacked flat plates. Counting the
// boughs ("six or seven") is what invites the stack, so the crown is asked for
// as one merged ragged cone instead, and the bonsai it kept drawing is named and
// refused. The trunk needs both a thickness and a low first bough, or it returns
// as a bare pole.
const pine = TREE_SPECIES.find((s) => s.id === 'v9-pine')
const pineText = pine.prompt.toLowerCase()
check(/lowest quarter/.test(pineText) && /barely a quarter of the way up the trunk/.test(pineText),
  'the pine\'s foliage starts low on the trunk, not halfway up')
check(/no bare pole under an umbrella/.test(pineText),
  'and the umbrella-on-a-pole it drew instead is refused by name')
check(/thirtieth of the tree's height/.test(pineText), 'and the trunk under it has a stated thickness, which is what stops it being a stick')
check(/no evenly stacked tiers/.test(pineText) && /not a bonsai/.test(pineText),
  'the stacked-plate bonsai it keeps drawing is refused by name')
check(/merging into their neighbours/.test(pineText) && /one ragged irregular cone/.test(pineText),
  'and the crown is asked for as one merged mass, since counting boughs is what stacks them')
check(!/\b(six or seven|five or six|four or five)\b/.test(pineText),
  'the pine does not count its boughs')

// --- the species table -------------------------------------------------------

console.log('\nspecies table')
check(new Set(TREE_SPECIES.map((s) => s.id)).size === TREE_SPECIES.length, 'species ids are unique')
for (const s of TREE_SPECIES) {
  check(/^[a-z0-9-]+$/.test(s.id), `"${s.id}" is a usable id`)
  check(s.heightM > 0 && s.heightM < 60, `"${s.id}" has a plausible height`, `${s.heightM}m`)
  check(Boolean(s.prompt), `"${s.id}" carries a prompt`)
  check(/low-poly/.test(s.prompt), `"${s.id}" asks for a low-poly model rather than a picture of a tree`)
  // The ratios, per species. An adjective ("broad", "slender") is drawn as a
  // diagram of a tree; a ratio against the tree's own height is drawn as a tree,
  // and it is the only part of the prompt that fixes the proportions.
  check(/as wide as the tree is tall/.test(s.prompt), `"${s.id}" states its crown width against its height`)
  check(/trunk is[^.]*thick|thick[^.]*trunk/.test(s.prompt), `"${s.id}" states how thick its trunk is`)
  // The paint step can only paint faces that exist: a canopy swallowing the
  // trunk has no bark region in it and no amount of clicking recovers one.
  check(/clear of branches|bare only for|undivided|divides/.test(s.prompt), `"${s.id}" says where its lowest branches start`)
  // The bench opens its slot table on these two files. A rename in public/trees
  // leaves the paint stage with nothing to click with, at the point where a
  // mesh has already been paid for.
  for (const key of ['bark', 'foliage']) {
    check(fs.existsSync(path.join(ROOT, 'public/trees', s[key])), `"${s.id}" ${key} texture exists`, s[key])
  }
  check(speciesById(s.id) === s, `speciesById finds "${s.id}"`)
}
check(speciesById('not-a-tree') === null, 'speciesById returns null for an unknown id')

// --- the price ---------------------------------------------------------------

console.log('\nmesh price')
check(estimateCredits({ step: 'mesh', texture: false }) === 40, 'a bare P1 mesh is 40 credits')
check(estimateCredits({ step: 'mesh', texture: true }) === 50, 'a textured P1 mesh is 50 credits')
check(estimateCredits({ step: 'mesh', texture: false }) < estimateCredits({ step: 'mesh', texture: true }),
  'turning the texture off is what makes the default cheaper -- every face is repainted downstream')

// The image model arrives from the browser and decides what the account is
// billed for -- Nano Banana Pro is ten times FLUX a click. Passing it through
// unchecked is a stranger on the LAN choosing the bill, which is the same shape
// of hole as the id validator above.
console.log('\nimage models')
check(IMAGE_MODELS.length > 1, 'more than one model is offered -- the bench is a comparison')
check(IMAGE_MODELS.every((m) => m.id && m.label && m.usd > 0), 'every offered model carries an id, a label and a price to print')
check(IMAGE_MODELS.every((m, i, a) => i === 0 || a[i - 1].usd <= m.usd), 'the list is cheapest first')
check(throws(() => requireImageModel('anthropic/expensive-thing')), 'a model the list does not offer is refused, not billed')
check(throws(() => requireImageModel(undefined)), 'and so is a missing one')
check(requireImageModel(IMAGE_MODELS[0].id) === IMAGE_MODELS[0], 'an offered model comes back as its own entry, with its price')
{
  const config = fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8')
  const image = config.slice(config.indexOf("'/__tree9-image'"), config.indexOf("'/__tree9-pick'"))
  check(/requireImageModel\(/.test(image), 'and the tree image endpoint runs a model id through that check before generating')
}

// --- the mesh slot claim ------------------------------------------------------
//
// Several mesh tasks are in flight at once now, and each one costs 40 credits.
// The claim on a numbered slot in meshes/ has to be indivisible: a slot number
// derived before an `await` is a number two tasks can both read, and the second
// writes over the first's file, leaving one mesh where two were bought. Node's
// single thread is the guarantee, and it only holds while that stretch contains
// no await -- which is a one-line edit to lose and impossible to see going.

console.log('\nmesh slot claim')
{
  const src = fs.readFileSync(path.join(ROOT, 'tools/trees/v9/workspace.mjs'), 'utf8')
  const from = src.indexOf('const meshDir =')
  const to = src.indexOf('writeState(id, fresh)')
  check(from > 0 && to > from, 'runMesh claims a numbered slot and writes state after it')
  const claim = src.slice(from, to)
  check(!/\bawait\b/.test(claim), 'and nothing in between awaits -- the claim is one synchronous run')
  check(/flag: 'wx'/.test(claim), 'the write itself is exclusive, for a file another dev server put there')
  check(/pickMesh\(id, file\)/.test(src.slice(to)) && /!fresh\.pickedMesh/.test(src.slice(to)),
    'and a landing mesh auto-picks only when nothing is picked, so a deliberate pick survives it')
}

// --- test surfaces -----------------------------------------------------------

/** A closed axis-aligned box, indexed, welded: 8 points, 12 triangles. */
function box(sx = 1, sy = 1, sz = 1) {
  const h = [sx / 2, sy / 2, sz / 2]
  const positions = new Float32Array([
    -h[0], -h[1], -h[2], h[0], -h[1], -h[2], h[0], h[1], -h[2], -h[0], h[1], -h[2],
    -h[0], -h[1], h[2], h[0], -h[1], h[2], h[0], h[1], h[2], -h[0], h[1], h[2],
  ])
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // -z
    4, 5, 6, 4, 6, 7, // +z
    0, 1, 5, 0, 5, 4, // -y
    3, 7, 6, 3, 6, 2, // +y
    0, 4, 7, 0, 7, 3, // -x
    1, 2, 6, 1, 6, 5, // +x
  ])
  return { positions, indices }
}

/** An open tube about Y: `seg` quads around, `radius` wide, `height` tall. */
function tube(seg = 16, radius = 0.5, height = 4) {
  const positions = []
  const indices = []
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2
    positions.push(Math.cos(a) * radius, 0, Math.sin(a) * radius)
    positions.push(Math.cos(a) * radius, height, Math.sin(a) * radius)
  }
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg
    const b0 = i * 2, b1 = i * 2 + 1, n0 = j * 2, n1 = j * 2 + 1
    indices.push(b0, n0, n1, b0, n1, b1)
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

// --- unwelding ---------------------------------------------------------------

console.log('\nunweld')
{
  const src = box()
  const m = unweld(src)
  check(faceCount(m) === 12, 'a box unwelds to 12 faces', `${faceCount(m)}`)
  check(m.positions.length === 12 * 9, 'every face gets its own three vertices')
  check(m.indices.length === 36 && m.indices[35] === 35, 'the index buffer is the identity')

  // Flat normals, because a 1000-triangle canopy has facets and smoothing them
  // is what makes a low-poly crown read as a balloon.
  const frames = faceFrames(m.positions)
  let flat = true
  for (let f = 0; f < 12; f++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) {
        if (Math.abs(m.normals[(f * 3 + j) * 3 + k] - frames.normals[f * 3 + k]) > 1e-6) flat = false
      }
    }
  }
  check(flat, 'a mesh with no normals gets flat per-face ones')
  check(throws(() => unweld({ positions: new Float32Array(9), indices: new Uint32Array(4) })),
    'an index count that is not whole triangles throws')
  check(Math.abs(boundsDiagonal(m.positions) - Math.sqrt(3)) < 1e-5, 'boundsDiagonal measures the box')
}

// --- adjacency and flood fill -------------------------------------------------

console.log('\nadjacency and flood fill')
{
  const m = unweld(box())
  const { neighbours } = buildFaceAdjacency(m.positions)
  let open = 0
  for (const n of neighbours) if (n < 0) open++
  check(open === 0, 'a closed box has no open edges after unwelding and re-keying', `${open} open`)

  const frames = faceFrames(m.positions)
  const side = floodFill({ neighbours, faceNormals: frames.normals }, 0, { angleDeg: 40 })
  check(side.reduce((s, x) => s + x, 0) === 2, 'a 40 deg fill on a box takes the seed face and its coplanar twin only')
  check(throws(() => floodFill({ neighbours, faceNormals: frames.normals }, 99, {})), 'a seed outside the mesh throws')

  const capped = floodFill({ neighbours, faceNormals: frames.normals }, 0, { angleDeg: 89, maxFaces: 4 })
  check(capped.reduce((s, x) => s + x, 0) <= 4, 'maxFaces caps the fill')
}
{
  // The relative-to-neighbour rule, which is the whole reason one click selects
  // a trunk: 16 segments is 22.5 deg a step, so a 40 deg fill walks the ring,
  // while the seed-relative version it would be a one-word edit to become stops
  // after a quarter turn.
  const m = unweld(tube(16))
  const { neighbours } = buildFaceAdjacency(m.positions)
  const frames = faceFrames(m.positions)
  const ring = floodFill({ neighbours, faceNormals: frames.normals }, 0, { angleDeg: 40 })
  check(ring.reduce((s, x) => s + x, 0) === 32, 'a 40 deg fill walks the whole tube', `${ring.reduce((s, x) => s + x, 0)}/32`)

  const tight = floodFill({ neighbours, faceNormals: frames.normals }, 0, { angleDeg: 10 })
  check(tight.reduce((s, x) => s + x, 0) < 32, 'below the per-step turn the fill stops, so the angle still means something')
}

// --- the brush ----------------------------------------------------------------

console.log('\nbrush')
{
  const m = unweld(tube(16, 0.5, 4))
  const { centroids } = faceFrames(m.positions)
  const all = facesInSphere(centroids, [0, 2, 0], 10)
  check(all.reduce((s, x) => s + x, 0) === 32, 'a big enough sphere takes every face')
  const none = facesInSphere(centroids, [0, 100, 0], 1)
  check(none.reduce((s, x) => s + x, 0) === 0, 'a sphere off the mesh takes nothing')
  const some = facesInSphere(centroids, [0.5, 2, 0], 1)
  const count = some.reduce((s, x) => s + x, 0)
  check(count > 0 && count < 32, 'a sphere on the surface takes a region', `${count} faces`)
}

// --- projection ---------------------------------------------------------------

console.log('\nUV projection')
{
  const m = unweld(box(2, 2, 2))
  const faceSlot = new Int16Array(12).fill(0)
  check(throws(() => projectUvs(m.positions, faceSlot, [{ projection: 'spherical', tileMetres: 1 }])),
    'an unknown projection throws')
  check(throws(() => projectUvs(m.positions, faceSlot, [{ projection: 'planar', tileMetres: 0 }])),
    'a zero tile size throws rather than dividing by nothing')
  check(throws(() => projectUvs(m.positions, faceSlot, [{ projection: 'planar' }])),
    'a missing tile size throws')
  check(throws(() => projectUvs(m.positions, new Int16Array(3), [{ projection: 'planar', tileMetres: 1 }])),
    'a faceSlot of the wrong length throws')
  check(throws(() => projectUvs(m.positions, new Int16Array(12).fill(3), [{ projection: 'planar', tileMetres: 1 }])),
    'a face painted with a slot the pool does not have throws')

  // Planar: a 2 m box at 1 m per tile spans 2 tiles on every side, which is the
  // constant-texel-density claim stated as a number.
  const { uvProj, slots } = projectUvs(m.positions, faceSlot, [{ projection: 'planar', tileMetres: 1 }])
  let lo = Infinity, hi = -Infinity
  for (const v of uvProj) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
  check(Math.abs(hi - lo - 2) < 1e-5, 'a 2 m box at 1 m per tile covers 2 tiles', `${(hi - lo).toFixed(3)}`)
  check(slots[0].faces === 12 && slots[0].metresPerTile === 1, 'the planar slot reports what it was asked for')

  const unpainted = projectUvs(m.positions, new Int16Array(12).fill(-1), [{ projection: 'planar', tileMetres: 1 }])
  check(unpainted.uvProj.every((v) => v === 0), 'unpainted faces keep a zero UV rather than a hole')
  check(unpainted.slots[0].faces === 0, 'and are not counted against any slot')
}
{
  // Cylindrical, on a tube whose circumference is exactly 8 tiles at the size
  // asked for -- so the rounding is a no-op and any drift is a real error.
  const radius = 0.5
  const m = unweld(tube(16, radius, 4))
  const faceSlot = new Int16Array(32).fill(0)
  const tileMetres = (2 * Math.PI * radius) / 8
  const { uvProj, slots } = projectUvs(m.positions, faceSlot, [{ projection: 'cylindrical', tileMetres }])
  const rep = slots[0]

  check(Number.isInteger(rep.repeatsAround) && rep.repeatsAround > 0,
    'the repeat count around is a positive whole number -- a fraction is a stripe down one side', `${rep.repeatsAround}`)
  check(rep.repeatsAround === 8, 'and it is the count the asked-for size implies')
  check(Math.abs(rep.metresPerTile - tileMetres) < 1e-4, 'the achieved size is reported and matches when rounding is a no-op')
  check(Math.abs(rep.radiusMean - radius) < 1e-5, 'the mean radius is measured off the faces')
  check(Math.abs(rep.axis[0]) < 1e-5 && Math.abs(rep.axis[1]) < 1e-5, 'the axis is the slot\'s own centre')

  // The branch cut: no single face may span more than half a turn of u, which
  // is what a face straddling atan2's -X meridian would do -- the whole texture
  // stretched backwards across one triangle.
  let widest = 0
  for (let f = 0; f < 32; f++) {
    let flo = Infinity, fhi = -Infinity
    for (let j = 0; j < 3; j++) {
      const u = uvProj[(f * 3 + j) * 2]
      flo = Math.min(flo, u)
      fhi = Math.max(fhi, u)
    }
    widest = Math.max(widest, fhi - flo)
  }
  check(widest < rep.repeatsAround / 2, 'no face straddles the branch cut', `widest span ${widest.toFixed(3)} tiles`)
  check(Math.abs(widest - rep.repeatsAround / 16) < 1e-4, 'and each face spans exactly its own segment')

  // v runs up, in metres, so bark on a 4 m trunk covers height/tileMetres tiles.
  let vlo = Infinity, vhi = -Infinity
  for (let i = 0; i < uvProj.length / 2; i++) {
    vlo = Math.min(vlo, uvProj[i * 2 + 1])
    vhi = Math.max(vhi, uvProj[i * 2 + 1])
  }
  check(Math.abs(vhi - vlo - 4 / tileMetres) < 1e-4, 'v is height in tiles, so bark runs up at the size asked for')

  // Rounding is visible, not silent: ask for a size the circumference is not a
  // whole number of, and the achieved size differs and says so.
  const odd = projectUvs(m.positions, faceSlot, [{ projection: 'cylindrical', tileMetres: tileMetres * 1.4 }])
  check(Number.isInteger(odd.slots[0].repeatsAround), 'an awkward size still rounds to a whole count')
  check(Math.abs(odd.slots[0].metresPerTile - tileMetres * 1.4) > 1e-3,
    'and the achieved size differs from the asked-for one, which is why it is reported back')
}

// --- assembly ------------------------------------------------------------------

console.log('\npainted mesh')
{
  const m = unweld(tube(16, 0.5, 4))
  const faceSlot = new Int16Array(32)
  for (let f = 0; f < 32; f++) faceSlot[f] = f < 16 ? 0 : 1
  const built = buildPaintedMesh(m, faceSlot, [
    { projection: 'cylindrical', tileMetres: 0.4, layer: 7 },
    { projection: 'planar', tileMetres: 2, layer: 3 },
  ])
  check(built.texLayer.length === 32 * 3, 'texLayer is per vertex')
  check(built.uvProj.length === 32 * 3 * 2, 'uvProj is per vertex')
  let consistent = true
  for (let f = 0; f < 32; f++) {
    const want = f < 16 ? 7 : 3
    for (let j = 0; j < 3; j++) if (built.texLayer[f * 3 + j] !== want) consistent = false
  }
  check(consistent, 'every vertex of a face carries its slot\'s WORLD layer, not the slot index')
  check(built.slots[0].faces === 16 && built.slots[1].faces === 16, 'the report counts faces per slot')
}

// --- grounding -------------------------------------------------------------------

console.log('\nground and scale')
{
  // A crown that leans: the trunk is the thin part at the bottom, and the mesh's
  // own centre is dragged sideways by the canopy. Centring on the whole bounds
  // would put the trunk off the origin and the tree would pivot around thin air
  // when the scatter yaws it.
  const trunk = tube(16, 0.2, 3)
  const crown = tube(16, 1.2, 1)
  const positions = new Float32Array(trunk.positions.length + crown.positions.length)
  positions.set(trunk.positions, 0)
  for (let i = 0; i < crown.positions.length; i += 3) {
    positions[trunk.positions.length + i] = crown.positions[i] + 4      // leaning +x
    positions[trunk.positions.length + i + 1] = crown.positions[i + 1] + 3
    positions[trunk.positions.length + i + 2] = crown.positions[i + 2]
  }
  const indices = new Uint32Array(trunk.indices.length + crown.indices.length)
  indices.set(trunk.indices, 0)
  for (let i = 0; i < crown.indices.length; i++) {
    indices[trunk.indices.length + i] = crown.indices[i] + trunk.positions.length / 3
  }
  const m = unweld({ positions, indices })

  const out = groundAndScale(m.positions, 9)
  let loY = Infinity, hiY = -Infinity
  for (let i = 1; i < m.positions.length; i += 3) {
    loY = Math.min(loY, m.positions[i])
    hiY = Math.max(hiY, m.positions[i])
  }
  check(Math.abs(loY) < 1e-5, 'the foot lands at y = 0', `${loY.toExponential(1)}`)
  check(Math.abs(hiY - 9) < 1e-4, 'the crown lands at the height asked for', `${hiY.toFixed(4)}m`)
  check(Math.abs(out.scale - 9 / 4) < 1e-5, 'the reported scale is the one applied')

  // The foot, not the bounds, is on the origin.
  let fx = 0, fz = 0, n = 0
  for (let i = 0; i < m.positions.length; i += 3) {
    if (m.positions[i + 1] < 0.2) { fx += m.positions[i]; fz += m.positions[i + 2]; n++ }
  }
  check(n > 0 && Math.abs(fx / n) < 0.05 && Math.abs(fz / n) < 0.05,
    'the trunk sits on the origin even though the crown leans', `foot centre ${(fx / n).toFixed(3)}, ${(fz / n).toFixed(3)}`)
  check(throws(() => groundAndScale(new Float32Array([0, 1, 0, 1, 1, 0, 0, 1, 1]), 5)),
    'a mesh with no height throws rather than dividing by zero')
}

// --- the bench is wired up --------------------------------------------------------

console.log('\nbench wiring')
{
  const html = path.join(ROOT, 'gen-tree-v9.html')
  check(fs.existsSync(html), 'gen-tree-v9.html exists -- a bench is registered by its file being there')
  const page = fs.readFileSync(html, 'utf8')
  check(page.includes('/src/gen-tree-v9-main.js'), 'the page loads its own main module')
  check(fs.existsSync(path.join(ROOT, 'src/gen-tree-v9-main.js')), 'that module exists')

  const config = fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8')
  for (const route of ['species', 'pool', 'image', 'mesh', 'lod', 'paint', 'delete-candidate', 'pick-mesh']) {
    check(config.includes(`/__tree9-${route}`), `the dev server serves /__tree9-${route}`)
  }
  check(/plugins:.*treeGen\(\)/.test(config), 'treeGen() is registered in the plugin list')

  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
  check(ignore.includes('tools/trees/v9/work/'), 'the work directory is gitignored -- it holds paid-for sources, not shipped assets')
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'all tree-v9 checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
