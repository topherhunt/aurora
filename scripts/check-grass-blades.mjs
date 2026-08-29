// Node-side gates for the blade clump (src/props/grass-blades.js, previewed at
// /gen-grass, design/05-rendering.md §5).
//
//   node scripts/check-grass-blades.mjs
//
// This model exists because the card bed's fragment work is 81% discarded, so
// every gate below is protecting one of the properties that trade was made for.
// In the order they cost the most if they drift:
//
//   THE MATERIAL GROWS AN ALPHA CHANNEL. A map, an alphaTest or a transparent
//   flag on this material puts a `discard` back in the fragment shader, which
//   on a tiled Adreno turns off low-resolution-Z for the whole draw -- and the
//   entire point of the blade bed is that it does not do that. It renders fine
//   and it costs the headset the frame. Checked first.
//
//   THE FEET STOP BEING (1,1,1). The base vertex colour is multiplied by the
//   per-instance colour in three's `color_vertex` chunk, and the instance
//   colour is the colour the ground at that spot is drawn in. Anything but
//   white at the foot double-tints it, and the clump stops growing out of the
//   ground and starts sitting on it. Invisible in a screenshot of one clump;
//   obvious as a pale or dark stipple across a hillside.
//
//   THE TIP BRIGHTNESS COMES BACK INTO THE GEOMETRY. It is per instance now,
//   `aTipMul`, applied in the vertex patch -- which is why the vertex patch is
//   installed on the no-wind build too. Baking it into the tip's vertex colour
//   as well would apply the same number twice, and a bed where every clump
//   shares one tip factor reads as a single two-tone material stamped over and
//   over. The tip's own vertex colour carries HUE only.
//
//   THE BILL PER CLUMP MOVES. Ten triangles is the whole budget argument: at
//   the preview defaults the disc is ~20k clumps, so one extra triangle per
//   blade is 200k triangles -- more than the terrain's entire share. A second
//   triangle per blade to round the taper is exactly the change that looks
//   harmless in the generator and is not.
//
//   THE HEIGHTS STOP VARYING, OR STOP BEING 0.3 m. The spec is a 0.30 m mean
//   with +/-20%. A stuck random gives a bed of clones that renders perfectly;
//   drifting the mean changes what "density 6" looks like and silently
//   invalidates every look call made against the sliders.
//
//   THE BLADES STOP FANNING. Ten yaws inside one clump is what removes the
//   card's edge-on degenerate angle, and the outward lean is what makes a clump
//   read as a fountain rather than a bundle of sticks. Both are one line and
//   neither throws.
//
//   THE NORMALS STOP LEANING UP. A blade lit by its true face normal goes black
//   edge-on to the sun and a field of them is salt-and-pepper noise. The bend
//   toward up is renormalised, and losing the renormalise shortens the vector
//   and quietly darkens the whole bed instead of failing.

import THREE from '../src/three-instance.js'

import { BLADE_DEFAULTS, bladeTipMul, buildBladeClump, createBladeMaterial } from '../src/props/grass-blades.js'
import { mulberry32 } from '../src/sim/mathx.js'

let failures = 0
function check(ok, label, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const near = (a, b, tol) => Math.abs(a - b) <= tol

// The three include sites the patch reaches for, in the order three emits them.
// A patch that misses one is a silent no-op -- String.replace on an absent
// needle returns the string -- so the stub has to carry all three.
const SHADER_SRC = '#include <common>\nvoid main() {\n#include <color_vertex>\n#include <begin_vertex>\n#include <project_vertex>\n}\n'
const FRAG_SRC = '#include <common>\nvoid main() {\n#include <normal_fragment_begin>\n}\n'

// Reads one clump back as blades, which is what every section below argues over.
function blades(geo, sink) {
  const pos = geo.getAttribute('position').array
  const nrm = geo.getAttribute('normal').array
  const col = geo.getAttribute('color').array
  const ramp = geo.getAttribute('aBladeT').array
  const out = []
  for (let b = 0; b * 9 < pos.length; b++) {
    const o = b * 9
    const foot = { x: (pos[o] + pos[o + 3]) / 2, y: pos[o + 1], z: (pos[o + 2] + pos[o + 5]) / 2 }
    out.push({
      foot,
      apex: { x: pos[o + 6], y: pos[o + 7], z: pos[o + 8] },
      // The blade's own plane, from the base edge.
      yaw: Math.atan2(pos[o + 5] - pos[o + 2], pos[o + 3] - pos[o + 0]),
      width: Math.hypot(pos[o + 3] - pos[o + 0], pos[o + 5] - pos[o + 2]),
      height: pos[o + 7] + sink,
      normal: { x: nrm[o], y: nrm[o + 1], z: nrm[o + 2] },
      footColor: [col[o], col[o + 1], col[o + 2]],
      tipColor: [col[o + 6], col[o + 7], col[o + 8]],
      ramp: [ramp[b * 3], ramp[b * 3 + 1], ramp[b * 3 + 2]],
    })
  }
  return out
}

// --- 1. the material --------------------------------------------------------

console.log('\n-- material --')

{
  const mat = createBladeMaterial()

  // THE ONE THAT MATTERS. Any of these four being set puts a `discard` back.
  check(mat.map === null || mat.map === undefined, 'no map', String(mat.map))
  check(mat.alphaMap === null || mat.alphaMap === undefined, 'no alpha map', String(mat.alphaMap))
  check(mat.alphaTest === 0, 'alphaTest is zero, so nothing discards', `alphaTest ${mat.alphaTest}`)
  check(mat.transparent === false, 'and it is not transparent, so it sorts as opaque',
    `transparent ${mat.transparent}`)

  check(mat.vertexColors === true, 'vertex colours are on, which is how the ramp and the terrain tint arrive')
  // Free here in a way it is not on the card bed: with no discard the tiler
  // keeps hidden-surface removal, so an occluded back face never shades.
  check(mat.side === THREE.DoubleSide, 'and it draws both sides, because you stand among them')
  check(mat.type === 'MeshLambertMaterial', 'Lambert, not Standard', mat.type)

  const u = mat.userData.uniforms
  check(!!u && 'uTime' in u && 'uWindAmp' in u && 'uWindFreq' in u && 'uWindSpeed' in u,
    'the wind uniforms are reachable from outside',
    u ? Object.keys(u).join(' ') : 'missing')

  // three keys its program cache on this string alone, so a shared key between
  // the two builds hands one of them the other's compiled shader.
  const nowind = createBladeMaterial({ wind: false })
  check(mat.customProgramCacheKey() !== nowind.customProgramCacheKey(),
    'and wind and no-wind do not share a program cache key',
    `${mat.customProgramCacheKey()} / ${nowind.customProgramCacheKey()}`)
  // No-wind is not unpatched: the tip brightness lives in the vertex shader and
  // is not optional, so both builds carry the colour block and only the wind
  // build carries the bend.
  const still = { uniforms: {}, vertexShader: SHADER_SRC, fragmentShader: FRAG_SRC }
  nowind.onBeforeCompile(still)
  check(still.vertexShader.includes('aTipMul'),
    'no-wind still gets the tip-brightness block, because that one is not optional')
  check(!still.vertexShader.includes('uWindAmp'),
    'and nothing else -- no wind uniforms, no bend')

  // DoubleSide above is only safe because of this. Three's double-sided path
  // flips the normal toward the viewer, and with normalUp pushing every blade
  // normal near vertical that hands a back-facing blade a normal aimed at the
  // ground: no sun term, hemisphere ground colour, black. Undoing the flip is
  // the difference between a lit bed and half a lit bed, and losing it is
  // silent -- everything still draws.
  const lit = { uniforms: {}, vertexShader: SHADER_SRC, fragmentShader: FRAG_SRC }
  mat.onBeforeCompile(lit)
  for (const [name, s] of [['wind', lit], ['no-wind', still]]) {
    check(s.fragmentShader.indexOf('#include <normal_fragment_begin>')
      < s.fragmentShader.indexOf('normal *= faceDirection'),
      `${name} undoes three's double-sided normal flip, after normal_fragment_begin`)
  }
}

// --- 2. the wind patch ------------------------------------------------------

console.log('\n-- wind --')

{
  const mat = createBladeMaterial()
  const shader = { uniforms: {}, vertexShader: SHADER_SRC, fragmentShader: '' }
  mat.onBeforeCompile(shader)
  const v = shader.vertexShader

  check(v.includes('attribute float aBladeT'), 'the ramp attribute is declared')
  check(shader.uniforms.uTime === mat.userData.uniforms.uTime,
    'and the uniform objects are shared, not copied, so setting uTime reaches the GPU')

  // Bending must happen after begin_vertex creates `transformed` and before
  // project_vertex applies the instance matrix.
  check(v.indexOf('#include <begin_vertex>') < v.indexOf('transformed.x += bend'),
    'the bend is applied after transformed exists')

  // The whole bed is instanced. Without the guard this is a compile error on
  // any non-instanced use of the same material. The nearest guard ABOVE the
  // read has to be the one still open at it, which is what the closing #endif
  // landing past it says.
  const im = v.indexOf('instanceMatrix')
  const guard = v.lastIndexOf('#ifdef USE_INSTANCING', im)
  check(guard >= 0 && v.indexOf('#endif', guard) > im,
    'and instanceMatrix is only read inside the USE_INSTANCING guard')

  // SQUARED. A linear ramp slides the whole blade sideways -- feet included --
  // and the bed reads as dragged rather than blown.
  check(v.includes('aBladeT * aBladeT'), 'the sway is quadratic in the ramp, so the feet do not move')
  // Phase off the clump's world origin, or the whole field nods in unison.
  check(v.includes('bladeRoot.x') && v.includes('bladeRoot.z'),
    'and the phase comes from the clump\'s world position, so the gust travels')
}

// --- 3. the shape -----------------------------------------------------------

console.log('\n-- shape --')

const geo = buildBladeClump({}, 7)
const b = blades(geo, BLADE_DEFAULTS.sink)

check(geo.index === null, 'non-indexed, because no two blades share a vertex')
check(geo.getAttribute('position').count === BLADE_DEFAULTS.blades * 3,
  `${BLADE_DEFAULTS.blades} triangles, ${BLADE_DEFAULTS.blades * 3} vertices`,
  `${geo.getAttribute('position').count} vertices`)
check(b.length === 10, 'ten blades, one triangle each -- the entire budget argument',
  `${b.length} blades, ${b.length} tris`)

// A stray attribute is not free: the bed is one InstancedMesh, so every extra
// float here is multiplied by 30 vertices and then by every clump in the disc.
const attrs = Object.keys(geo.attributes).sort().join(' ')
check(attrs === 'aBladeT color normal position', 'four attributes and no uv', attrs)
check(geo.getAttribute('aBladeT').itemSize === 1, 'the ramp is a scalar')

check(!!geo.boundingSphere && geo.boundingSphere.radius > 0,
  'and the bounding sphere is computed at build time',
  geo.boundingSphere ? `r ${geo.boundingSphere.radius.toFixed(3)}` : 'missing')

// --- 4. heights -------------------------------------------------------------

console.log('\n-- heights --')

{
  const hs = b.map((x) => x.height)
  const mean = hs.reduce((a, c) => a + c, 0) / hs.length
  const lo = BLADE_DEFAULTS.height * (1 - BLADE_DEFAULTS.heightVary)
  const hi = BLADE_DEFAULTS.height * (1 + BLADE_DEFAULTS.heightVary)

  // Ten samples of a uniform +/-20%, so the mean has real sampling slop in it.
  // 12% is loose enough not to flake on a reseed and tight enough to catch a
  // mean that has actually moved.
  check(near(mean, BLADE_DEFAULTS.height, BLADE_DEFAULTS.height * 0.12),
    'the mean blade is 0.30 m, which is the spec',
    `${mean.toFixed(4)} m against ${BLADE_DEFAULTS.height}`)
  check(hs.every((h) => h >= lo - 1e-6 && h <= hi + 1e-6),
    'and every blade is inside +/-20% of it',
    `${Math.min(...hs).toFixed(3)} - ${Math.max(...hs).toFixed(3)} m, band ${lo.toFixed(3)} - ${hi.toFixed(3)}`)
  // A stuck random renders perfectly and looks like one cloned plant.
  check(Math.max(...hs) - Math.min(...hs) > BLADE_DEFAULTS.height * 0.15,
    'and they actually vary rather than being ten of the same blade',
    `spread ${(Math.max(...hs) - Math.min(...hs)).toFixed(3)} m`)

  // One flat foot line rather than ten different ones, at whatever the sink is
  // -- 0 by default, so the (1,1,1) foot vertex is at the surface where its
  // terrain-matched colour can actually be seen.
  check(b.every((x) => near(x.foot.y, -BLADE_DEFAULTS.sink, 1e-6)),
    `every foot sits at y = -${BLADE_DEFAULTS.sink}, which is the sink`)
  const sunk = blades(buildBladeClump({ sink: 0.05 }, 3), 0.05)
  check(sunk.every((x) => near(x.foot.y, -0.05, 1e-6)),
    'and the sink still buries them when it is turned up')
  check(b.every((x) => x.apex.y > 0), 'and every apex is above ground',
    `lowest apex ${Math.min(...b.map((x) => x.apex.y)).toFixed(3)} m`)
}

// --- 5. the fan -------------------------------------------------------------

console.log('\n-- the fan --')

{
  // Ten distinct planes inside one clump is what removes the card's edge-on
  // degenerate angle. Rounded to a degree, because the test is "no two blades
  // are parallel", not "the floats differ".
  const yaws = new Set(b.map((x) => Math.round((x.yaw * 180 / Math.PI + 360) % 180)))
  check(yaws.size === b.length, 'every blade sits in its own plane, so no viewing angle is a sliver',
    `${yaws.size} distinct yaws of ${b.length}`)

  check(b.every((x) => near(x.width, BLADE_DEFAULTS.width, 1e-6)),
    'and each is the base width across', `${b[0].width.toFixed(4)} m`)

  // Lean is keyed to the foot's radius, so the middle stands up and the rim
  // splays. Measured as the apex moving OUTWARD from the clump's centre.
  //
  // ONLY THE BLADES THAT HAVE AN OUTWARD DIRECTION AT ALL, and the cut is
  // derived rather than picked. The radial splay at radius rr is
  // `lean * h * rr / clumpRadius`; the jitter on top of it is `lean * h * 0.18`
  // per axis, so its radial component is at worst `lean * h * 0.18 * sqrt(2)`
  // inward. `lean` and the blade's own `h` appear in both and cancel, leaving
  // splay > jitter exactly when
  //
  //     rr > clumpRadius * 0.18 * sqrt(2)
  //
  // -- inside that radius a blade may lean any way it likes, which is right,
  // because a foot on the clump's axis has no outward to lean along. Gating the
  // axis blades too passes on this seed and fails on about one seed in forty
  // (2 of 500 measured), which is worse than not gating at all.
  const jitterR = BLADE_DEFAULTS.clumpRadius * 0.18 * Math.SQRT2
  const offAxis = b.filter((x) => Math.hypot(x.foot.x, x.foot.z) > jitterR)
  const leaning = offAxis.filter((x) => {
    const rr = Math.hypot(x.foot.x, x.foot.z)
    return (x.apex.x * x.foot.x + x.apex.z * x.foot.z) / rr > rr
  })
  check(offAxis.length >= b.length * 0.5,
    'most feet sit off the clump axis, where the lean has a direction to have',
    `${offAxis.length} of ${b.length} past ${jitterR.toFixed(3)} m`)
  check(leaning.length === offAxis.length,
    'and every one of those leans outward, which is what makes it a fountain',
    `${leaning.length} of ${offAxis.length}`)

  const feet = b.map((x) => Math.hypot(x.foot.x, x.foot.z))
  check(Math.max(...feet) <= BLADE_DEFAULTS.clumpRadius + 1e-6,
    'the feet stay inside the clump radius',
    `furthest foot ${Math.max(...feet).toFixed(4)} m of ${BLADE_DEFAULTS.clumpRadius}`)
}

// --- 6. normals -------------------------------------------------------------

console.log('\n-- normals --')

{
  const lens = b.map((x) => Math.hypot(x.normal.x, x.normal.y, x.normal.z))
  // Losing the renormalise after the bend does not throw -- it shortens the
  // vector, which darkens the entire bed by a factor nobody can trace.
  check(lens.every((l) => near(l, 1, 1e-5)), 'unit length after the bend toward up',
    `${Math.min(...lens).toFixed(6)} - ${Math.max(...lens).toFixed(6)}`)
  check(b.every((x) => x.normal.y > 0), 'and every normal points up rather than into the ground',
    `lowest y ${Math.min(...b.map((x) => x.normal.y)).toFixed(4)}`)

  // The two ends of the knob, which is the cheapest way to prove the bend is a
  // lerp toward up and not something else.
  const up = blades(buildBladeClump({ normalUp: 1 }, 7), BLADE_DEFAULTS.sink)
  check(up.every((x) => near(x.normal.y, 1, 1e-6)),
    'normalUp 1 gives a clean (0,1,0), not a shortened vector')
  const raw = blades(buildBladeClump({ normalUp: 0 }, 7), BLADE_DEFAULTS.sink)
  check(raw.some((x) => x.normal.y < 0.9),
    'and normalUp 0 gives the true face normal back',
    `flattest ${Math.min(...raw.map((x) => x.normal.y)).toFixed(4)}`)
}

// --- 7. colour --------------------------------------------------------------

console.log('\n-- colour --')

{
  // THE TERRAIN-MATCH INVARIANT. `color_vertex` multiplies this by the instance
  // colour, and the instance colour is the colour the ground at that spot is
  // drawn in.
  check(b.every((x) => x.footColor.every((c) => c === 1)),
    'the feet are exactly (1,1,1), so the instance colour lands on them unmodified',
    b[0].footColor.join(','))
  // HUE ONLY at the tip. Brightness is aTipMul, per instance; a gain baked in
  // here as well would be the same number applied twice.
  check(b.every((x) => near(x.tipColor[1], 1, 1e-6)),
    'and the tips carry no brightness of their own -- green is exactly 1',
    b[0].tipColor.map((c) => c.toFixed(3)).join(','))
  check(b.every((x) => x.ramp[0] === 0 && x.ramp[1] === 0 && x.ramp[2] === 1),
    'the ramp runs 0 at both feet and 1 at the apex, so the interpolator draws the gradient')

  // Warm skews red against blue about a green of 1, so a bleached tip is a
  // different hue at the same value rather than a lighter one.
  const warm = blades(buildBladeClump({ tipWarm: 0.2 }, 7), BLADE_DEFAULTS.sink)[0].tipColor
  check(warm[0] > warm[1] && warm[1] > warm[2] && near(warm[1], 1, 1e-6),
    'tipWarm pushes red up and blue down without moving green',
    warm.map((c) => c.toFixed(3)).join(','))

  // --- the per-clump tip brightness.
  //
  // Two properties, and the second is the one worth a gate. A bed of clumps
  // that all brighten is a two-tone material stamped over and over, so the sign
  // has to split; and a clump whose multiplier lands near 1 has no gradient at
  // all, which is the thing tipVary exists to prevent.
  const mulRand = mulberry32(99)
  const muls = Array.from({ length: 400 }, () => bladeTipMul(BLADE_DEFAULTS, mulRand))
  const up = muls.filter((m) => m > BLADE_DEFAULTS.tipGain).length
  check(up > 140 && up < 260, 'tip brightness goes up about as often as it goes down',
    `${up} of ${muls.length} lighter`)
  const floor = BLADE_DEFAULTS.tipGain * BLADE_DEFAULTS.tipVary * 0.55
  check(muls.every((m) => Math.abs(m - BLADE_DEFAULTS.tipGain) >= floor - 1e-9),
    'and no clump lands on its own base colour, so every clump has a gradient',
    `closest ${Math.min(...muls.map((m) => Math.abs(m - BLADE_DEFAULTS.tipGain))).toFixed(4)}, floor ${floor.toFixed(4)}`)
  check(muls.every((m) => m > 0), 'and none of them goes negative',
    `${Math.min(...muls).toFixed(3)} - ${Math.max(...muls).toFixed(3)}`)

  // tipVary 0 is the plainer reading the slider still has to reach: every tip
  // lighter than its own base by exactly tipGain.
  const flatRand = mulberry32(7)
  const flat = Array.from({ length: 20 }, () => bladeTipMul({ tipGain: 1.4, tipVary: 0 }, flatRand))
  check(flat.every((m) => near(m, 1.4, 1e-9)),
    'tipVary 0 gives every clump the same tip, which is tipGain', flat[0].toFixed(3))
}

// --- 8. the knobs -----------------------------------------------------------

console.log('\n-- the knobs --')

for (const n of [1, 5, 20]) {
  const g = buildBladeClump({ blades: n }, 3)
  check(g.getAttribute('position').count === n * 3, `blades ${n} builds ${n} triangles`,
    `${g.getAttribute('position').count / 3} tris`)
}

{
  const tall = blades(buildBladeClump({ height: 0.6, heightVary: 0 }, 3), BLADE_DEFAULTS.sink)
  check(tall.every((x) => near(x.height, 0.6, 1e-6)),
    'heightVary 0 gives ten identical heights, which is the knob\'s other end',
    `${tall[0].height.toFixed(4)} m`)

  // Fail explicitly rather than handing back a geometry with NaNs in it or a
  // clump of zero-area triangles that renders as nothing.
  const throws = (fn) => { try { fn(); return false } catch { return true } }
  check(throws(() => buildBladeClump({ blades: 0 })), 'zero blades throws')
  check(throws(() => buildBladeClump({ height: 0 })), 'zero height throws')
  check(throws(() => buildBladeClump({ width: 0 })), 'and a zero-width blade throws rather than going degenerate')
}

// --- 9. determinism ---------------------------------------------------------

console.log('\n-- determinism --')

{
  // The bed picks a clump per instance by seed, so the same seed has to give
  // the same clump across a rebuild or the field reshuffles when a slider moves.
  const a = buildBladeClump({}, 42).getAttribute('position').array
  const c = buildBladeClump({}, 42).getAttribute('position').array
  check(a.every((v, i) => v === c[i]), 'the same seed builds the same clump')
  const d = buildBladeClump({}, 43).getAttribute('position').array
  check(a.some((v, i) => v !== d[i]), 'and a different seed builds a different one')
}

// --- 10. the bill -----------------------------------------------------------

console.log('\n-- the bill --')

{
  // The density law is `keep = min(1, F / d)`, integrated over the disc:
  // density * pi * F * (2R - F). Same law the card bed places by, so these
  // counts are directly comparable to check-grass's.
  const tris = BLADE_DEFAULTS.blades
  const clumps = (density, F, R) => Math.ceil(density * Math.PI * F * (2 * R - F))

  console.log('        density  full  cull     clumps      tris   blades/m2')
  for (const [density, F, R] of [[6, 8, 70], [6, 8, 40], [3, 8, 70], [12, 8, 70], [24, 8, 70]]) {
    const n = clumps(density, F, R)
    console.log(`        ${String(density).padStart(7)}  ${String(F).padStart(4)}  ${String(R).padStart(4)}`
      + `  ${String(n).padStart(9)}  ${String(n * tris).padStart(8)}  ${String(density * tris).padStart(10)}`)
  }

  // The preview defaults have to leave room for the terrain (45k) and the
  // forest inside the 350k ceiling, and the user's arena measurement says the
  // real ceiling is nearer 1M. This gates the defaults, not the sliders.
  const shipped = clumps(6, 8, 70) * tris
  check(shipped < 250e3, 'the default disc fits with room for the terrain and the forest',
    `${(shipped / 1000).toFixed(0)}k triangles of the 350k ceiling`)
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'all blade checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
