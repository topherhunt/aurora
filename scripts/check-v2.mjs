// The §18 gate, whole.
//
//   node scripts/check-v2.mjs
//
// v2 is built as six independent pieces and each ships its own check-v2-*.mjs
// that runs standalone. This is the file `npm run check` calls: it imports each
// section's run(), runs them in the order the field is evaluated in, and fails
// on the first section that throws.
//
// SECTIONS ARE LISTED EXPLICITLY AND THE LIST IS ASSERTED AGAINST THE DIRECTORY.
// A discovered-by-glob runner would be shorter, and it would also mean that
// deleting a section file makes the gate pass faster and quieter -- the exact
// failure mode a gate exists to prevent. So the list below is the contract, and
// a check-v2-*.mjs on disk that nobody named here is an error with the same
// weight as a failing assertion.
//
// Ordering is not cosmetic. §18's field composes coarse -> detail -> layers ->
// LOD -> surfaces -> editing, and a failure upstream makes every downstream
// number meaningless. Reporting "the road surface is 8 cm off the terrain" is
// noise when the heightmap underneath it decoded wrong, so the run stops at the
// first section that throws rather than collecting a screenful of consequences.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const V2 = join(HERE, '..', 'src', 'v2')

// --- section 0: the two import boundaries -----------------------------------
//
// Neither boundary belongs to any one module, so no per-module check owns them,
// and both fail in ways that look like something else entirely.
//
// v2 DOES NOT REPLACE v1 (§18). The whole premise is that the coarse shape comes
// from an image rather than from a noise function, so an import of v1's height
// field anywhere under src/v2/ means some module quietly went back to the
// procedural world -- and it would still render, just not the authored terrain.
// The shared LEAF modules are fine and listed in §18; it is specifically
// terrain-height.js and phase-a.js that are v1's answer to the question v2 is
// asking differently.
//
// THREE-FREE (DESIGN.md Constraint 3). src/v2/height/ and src/v2/layers/ must
// run under node so this gate can check them headlessly. One `import * as THREE`
// added for one Vector3 is enough to make every one of those checks
// unrunnable, and the error it produces at that point is about a missing DOM,
// which reads as a broken gate rather than a broken rule.
const FORBIDDEN = [
  [/^src\/v2\//, /from\s+['"][^'"]*sim\/(terrain-height|phase-a)\.js['"]/, "imports v1's procedural height field"],
  [/^src\/v2\/(height|layers)\//, /from\s+['"]three['"]|from\s+['"]three\//, 'imports three.js inside the three-free boundary'],
]

// --- section 0b: the world extent agrees with itself ------------------------
//
// The extent changed three times while v2 was being written -- 16384, then 4096,
// then 8192 -- because §18's premise is that the imported picture decides how big
// the world is, and the picture's scale is an authoring decision that can change
// again. Each change has to land in three places, and two of them drift silently:
//
//   src/v2/config.js         WORLD_SIZE, which the code reads
//   public/world/height.json meta.world, which the baked asset was rendered at
//   design/18-v2-world.md    the constants block six parallel agents code against
//
// heightmap.js throws when the first two disagree, which is the right behaviour
// and is why that pair is not the worry. The DOC is the worry: nothing executes
// it, so a stale constants block is invisible until someone builds against it
// and produces a module that is wrong in a way no test covers. That happened
// twice in one afternoon, so it gets an assertion.
//
// A scan for hardcoded 8192/4096 literals was tried here first and dropped: it
// fired on `rand() * 4096` (a noise-domain offset) and on a documented 16384
// cell-coordinate packing bound, neither of which is a world extent. Two renames
// of correct code to satisfy a checker is a worse trade than the risk it covers.
function extentAgreement() {
  const root = join(HERE, '..')
  const out = []

  const cfg = readFileSync(join(root, 'src', 'v2', 'config.js'), 'utf8')
  const cfgNum = (name) => {
    const m = cfg.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`))
    if (!m) throw new Error(`check-v2: config.js has no numeric ${name}`)
    return Number(m[1])
  }
  const worldSize = cfgNum('WORLD_SIZE')
  const maxDepth = cfgNum('MAX_DEPTH')

  const metaPath = join(root, 'public', 'world', 'height.json')
  if (statSync(metaPath, { throwIfNoEntry: false })) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    if (meta.world !== worldSize) {
      out.push(`public/world/height.json was baked at world ${meta.world} m, config.js says ${worldSize} m -- regenerate with scripts/make-heightmap.mjs`)
    }
  } else {
    out.push('public/world/height.json is missing -- run scripts/make-heightmap.mjs')
  }

  // The doc quotes the constants in a fenced js block. Read the same declarations
  // out of it and demand they match, so an edit to one is an edit to both.
  const doc = readFileSync(join(root, 'design', '18-v2-world.md'), 'utf8')
  for (const [name, want] of [['WORLD_SIZE', worldSize], ['MAX_DEPTH', maxDepth], ['WORLD_HALF', worldSize / 2]]) {
    const m = doc.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`))
    if (!m) out.push(`design/18-v2-world.md no longer quotes ${name} -- the constants block is what the parallel agents code against`)
    else if (Number(m[1]) !== want) out.push(`design/18-v2-world.md says ${name} = ${m[1]}, config.js says ${want}`)
  }

  // The one relationship that makes MAX_DEPTH mean "10 cm". A leaf node of
  // WORLD_SIZE / 2^MAX_DEPTH holds CHUNK_RES cells, so the finest cell is
  // that over CHUNK_RES. §18 promises 6.25 cm; anything coarser than 10 cm
  // breaks the promise the section is named for.
  const chunkRes = cfgNum('CHUNK_RES')
  const finestCell = worldSize / 2 ** maxDepth / chunkRes
  if (finestCell > 0.1) {
    out.push(`finest cell is ${(finestCell * 100).toFixed(1)} cm -- §18 promises down to 10 cm, so MAX_DEPTH is too low for a ${worldSize} m world`)
  }
  return { out, worldSize, maxDepth, finestCell }
}

// --- section 0c: the host wiring --------------------------------------------
//
// src/v2/main.js is the one v2 module no section below can touch: it constructs
// a WebGLRenderer on line one, so node cannot import it and every check-v2-*.mjs
// stops at its door. It is also where six modules meet, which makes it exactly
// the file where a contract gets broken quietly.
//
// So the four rules that are written down in those modules' headers as "the host
// must" are asserted here, by reading the text. Textual assertions are weak and
// this one is deliberately narrow: each line below corresponds to a failure that
// is INVISIBLE in the frame it happens in, which is what makes a weak check
// worth more than none.
function hostWiring() {
  const root = join(HERE, '..')
  const out = []
  const mainPath = join(root, 'src', 'v2', 'main.js')
  if (!statSync(mainPath, { throwIfNoEntry: false })) {
    return ['src/v2/main.js is missing -- v2.html loads it and /v2 renders nothing without it']
  }
  // COMMENT LINES ARE DROPPED FIRST, and finding that out cost a false failure:
  // main.js explains in prose why it must not call markers.update(), and the
  // first version of this check read that sentence as the call itself. A gate
  // that fires on a file DOCUMENTING the rule it enforces trains you to ignore
  // it. Whole-line only -- a trailing comment cannot hide a call, since the call
  // would be on the same line ahead of it.
  const src = readFileSync(mainPath, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  const html = readFileSync(join(root, 'v2.html'), 'utf8')

  if (!html.includes('/src/v2/main.js')) out.push('v2.html no longer loads /src/v2/main.js')

  // editor.js: "the host must NOT also call markers.update()". The handles are
  // scaled to a constant ANGULAR size from the camera, so a second call sizes
  // them for whichever camera came last -- which on the frame an XR session
  // starts is not the one being looked through.
  if (/\bmarkers\.update\s*\(/.test(src)) {
    out.push('src/v2/main.js calls markers.update() -- editor.update(dt, camera) owns that call, and two callers race on the handle scale')
  }

  // water-surfaces.js: the water shader recovers world position from
  // modelMatrix, so any transform on water.group slides every wave off the
  // world while the mesh stays put.
  if (/water\.group\.(position|rotation|scale|matrix)/.test(src)) {
    out.push('src/v2/main.js transforms water.group -- the water shader reads world position off modelMatrix and the waves would detach from the world')
  }

  // road-surfaces.js: without this the road is the only surface the night lift
  // and the horizon shadow never reach, and it reads as the brightest thing on
  // the hillside after sunset.
  if (!/lighting\.patch\(\s*roads\.material,\s*\{\s*mode:\s*'vertex'/.test(src)) {
    out.push("src/v2/main.js does not lighting.patch(roads.material, {mode: 'vertex'}) -- the road would stay lit after dark")
  }

  // sky-probe.js: the probe binds a render target and toggles renderer.xr off.
  // After the render it captures into the frame that was just presented.
  // LAST occurrence of each, not first: main.js renders once more from the
  // pre-boot branch, and anchoring on the first render would compare the probe
  // against a call that happens before the world exists.
  const probeAt = src.lastIndexOf('probe.update(renderer')
  const renderAt = src.lastIndexOf('renderer.render(')
  if (probeAt < 0) out.push('src/v2/main.js never calls probe.update() -- the water would reflect a black sky')
  else if (renderAt >= 0 && probeAt > renderAt) {
    out.push('src/v2/main.js calls probe.update() after renderer.render() -- the probe binds its own target and must run first')
  }
  return out
}

function jsFilesUnder(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) jsFilesUnder(p, out)
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

if (statSync(V2, { throwIfNoEntry: false })) {
  const root = join(HERE, '..')
  let violations = 0
  let scanned = 0
  for (const file of jsFilesUnder(V2)) {
    const rel = relative(root, file).split('\\').join('/')
    const src = readFileSync(file, 'utf8')
    scanned++
    for (const [where, pattern, why] of FORBIDDEN) {
      if (!where.test(rel)) continue
      const hit = src.match(pattern)
      if (hit) {
        console.log(` FAIL ${rel} ${why}   ${hit[0]}`)
        violations++
      }
    }
  }

  const agree = extentAgreement()
  for (const line of [...agree.out, ...hostWiring()]) {
    console.log(` FAIL ${line}`)
    violations++
  }
  console.log(
    `\n--- boundaries -- ${scanned} files under src/v2/, world ${agree.worldSize} m, ` +
      `depth <=${agree.maxDepth}, finest cell ${(agree.finestCell * 100).toFixed(2)} cm, ${violations} violation(s)`
  )
  if (violations) {
    console.log('\nv2: BOUNDARY OR EXTENT CHECK FAILED\n')
    process.exit(1)
  }
}

// module -> the §18 "The gate" section it implements. Order is evaluation order.
const SECTIONS = [
  ['check-v2-heightmap.mjs', 'heightmap -- PNG decode, metre round trip, C1 across a texel edge'],
  ['check-v2-field.mjs', 'field -- determinism, band limit monotone in cell, convergence at cell 0'],
  ['check-v2-layers.mjs', 'layers -- snow line interpolation, carve depths, dirty-rect rebake, culling rate'],
  ['check-v2-quadtree.mjs', 'quadtree -- split rule, depth ladder, slot pool high-water mark'],
  ['check-v2-terrain.mjs', 'streaming -- key packing, dirty-rect invalidation, fallback walks, eviction'],
  ['check-v2-surfaces.mjs', 'surfaces -- lake discs, river ribbons, road ribbons against the carved ground'],
  ['check-v2-edit.mjs', 'edit -- tool state machine, undo, document round trip'],
]

const named = new Set(SECTIONS.map(([file]) => file))
const onDisk = readdirSync(HERE).filter((f) => /^check-v2-.*\.mjs$/.test(f))
const unlisted = onDisk.filter((f) => !named.has(f))
const missing = SECTIONS.map(([file]) => file).filter((f) => !onDisk.includes(f))

if (unlisted.length || missing.length) {
  if (missing.length) console.log(`\nnamed in check-v2.mjs but not on disk: ${missing.join(', ')}`)
  if (unlisted.length) console.log(`on disk but not named in check-v2.mjs: ${unlisted.join(', ')}`)
  console.log('\nv2: SECTION LIST OUT OF DATE\n')
  process.exit(1)
}

let ran = 0
for (const [file, title] of SECTIONS) {
  console.log(`\n--- ${title}`)
  const mod = await import(join(HERE, file))
  if (typeof mod.run !== 'function') {
    console.log(`\nv2: ${file} exports no run()\n`)
    process.exit(1)
  }
  try {
    // A section signals failure by THROWING. It may also return its failure count, and that return value is checked too: check-v2-surfaces.mjs once returned the count WITHOUT throwing, which meant its FAIL lines printed and then this runner declared ALL SECTIONS PASSED over the top of them. A gate that can be silenced by a section's choice of error convention is not a gate, so both conventions are honoured here rather than trusting every section to pick the same one.
    const failures = await mod.run()
    if (typeof failures === 'number' && failures > 0) {
      console.log(`\nv2: ${file} reported ${failures} failure(s) by return value without throwing\n`)
      process.exit(1)
    }
  } catch (e) {
    // The section already printed its own ok/FAIL lines; this is the summary.
    console.log(`\nv2: ${e.message}\n`)
    process.exit(1)
  }
  ran++
}

console.log(`\nv2: ALL ${ran} SECTIONS PASSED\n`)
