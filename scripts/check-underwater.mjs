// The UNDERWATER path, checked as far as it can be without a GPU (§11).
//
// Nothing here renders a pixel -- there is no GL context in node. What it can
// do is pin the four things that fail silently, i.e. that produce a world which
// still draws, still runs, and is wrong:
//
//   1. THE SIDE. The underside of the surface exists only because the material
//      is DoubleSide. Back on FrontSide every back-facing triangle is culled
//      before it is shaded, so she swims under a lake and sees straight through
//      to the sky with no surface at all. Nothing throws, nothing warns, and on
//      the desktop canvas from above it looks perfect.
//   2. THE COLOUR SPACE. The murk goes to the water shader in LINEAR and to
//      every other material in the world as RAW sRGB, because the two do their
//      fog mix on opposite sides of colorspace_fragment. Both wrong ways round
//      look like a colour someone chose.
//   3. THE VISIBILITY. `visibility` is a distance and `fogDensity` is a rate,
//      and the conversion between them is inside an exponent. A version that
//      is off by the square, or that quietly interpolates between two authored
//      densities, is a lake you can see 60 m through, which reads as "the fog
//      knob wants turning up" rather than as a bug.
//   4. THE FOG TARGET. Water is deliberately exempt from the scene fog and
//      fades to the horizon sky instead. Underwater that exemption has to be
//      switched off, or a lake surface across the way is a lit hole in the murk.
//
// What this can NOT check: whether it looks like being underwater. That needs
// eyes, and on a headset (§17).

import fs from 'node:fs'
import * as THREE from 'three'
import { Sky } from '../src/sky.js'
import { SkyProbe } from '../src/sky-probe.js'
import { WorldProbe, WORLD_PROBE } from '../src/world-probe.js'
import { WorldLighting } from '../src/lighting.js'
import { Water, UNDERWATER, CURRENT, currentDrift, murkDensity, murkLinear, murkAir } from '../src/water.js'
import { WaterSurfaces } from '../src/v2/render/water-surfaces.js'
import { RIVER_WIDEN, RIVER_WIDEN_FRAC } from '../src/v2/render/ribbon.js'

// water-surfaces.js keeps its bucket hash private, so it is restated. Only ever
// called with (0, 0) below, where every hash of this shape agrees on 0 -- so the
// duplication decides nothing, and a real index built by reindex() is not what
// section 7 is about.
const bucketKeyFor = (i, j) => i * 100003 + j

let failures = 0
function check(ok, title, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? ' ok  ' : ' FAIL'} ${title}${detail ? `   ${detail}` : ''}`)
}

console.log('\nunderwater')

const scene = new THREE.Scene()
const lighting = new WorldLighting()
const worldProbe = new WorldProbe()
const water = new Water(scene, { sky: new Sky(scene), lighting, probe: new SkyProbe(), world: worldProbe })
const frag = water.material.fragmentShader

// --- 1. the side --------------------------------------------------------------

check(
  water.material.side === THREE.DoubleSide,
  'the water material is double-sided, so a surface exists when she is under it',
  `side is ${water.material.side}, DoubleSide is ${THREE.DoubleSide}`
)

// And the underside is the SAME material rather than a second one, which is
// what keeps this to zero extra draw calls. gl_FrontFacing is the line that
// makes that possible; without it a double-sided plane shades its back faces
// exactly like its front, i.e. it reflects the sky at you from underneath.
check(frag.includes('gl_FrontFacing'), 'and the two sides are one material, split per fragment')

// --- 2. the colour space ------------------------------------------------------
//
// The two forms of the murk must NOT be equal. They are the same colour, so
// anything that made them equal -- copying one into the other, skipping the
// conversion -- would be invisible in a diff and wrong in exactly one of the
// two places it is used. sRGB is above linear everywhere except 0 and 1.

check(
  murkAir.x > murkLinear.r && murkAir.y > murkLinear.g && murkAir.z > murkLinear.b,
  'the murk goes to the aerial ramp in sRGB and to the water shader in linear',
  `air ${murkAir.x.toFixed(4)},${murkAir.y.toFixed(4)},${murkAir.z.toFixed(4)} vs linear ${murkLinear.r.toFixed(4)},${murkLinear.g.toFixed(4)},${murkLinear.b.toFixed(4)}`
)

// ...and they are the same colour, which is the other half of the same claim.
// Round-tripped through three's own conversion rather than through a 2.4
// exponent written out here, so this cannot pass while the shipping code uses a
// different curve.
//
// THE TOLERANCE IS 1e-4 AND NOT 1e-12, and that is a fact about three rather
// than slack left for this code. Its LinearToSRGB raises to 0.41666, which is
// not 1/2.4 to the last digit, so it is not quite the inverse of the 2.4 its
// SRGBToLinear uses -- the round trip comes back about 3e-6 out. Tightening
// this past that would fail on a correct implementation; loosening it much
// further would stop discriminating between the two spaces, whose channels here
// differ by a factor of eight.
{
  const back = new THREE.Color()
  back.setRGB(murkAir.x, murkAir.y, murkAir.z, THREE.SRGBColorSpace)
  const d = Math.max(
    Math.abs(back.r - murkLinear.r),
    Math.abs(back.g - murkLinear.g),
    Math.abs(back.b - murkLinear.b)
  )
  check(d < 1e-4, 'and they are the same colour, not two colours', `worst channel ${d.toExponential(2)}`)
}

// It really is the authored hex, so editing UNDERWATER.murk moves both.
{
  const authored = new THREE.Color(UNDERWATER.murk)
  check(
    Math.abs(authored.r - murkLinear.r) < 1e-12
      && Math.abs(authored.g - murkLinear.g) < 1e-12
      && Math.abs(authored.b - murkLinear.b) < 1e-12,
    'and both are derived from UNDERWATER.murk rather than authored twice'
  )
}

// The uniform the shader actually gets is the linear one.
{
  const u = water.uniforms.uMurk.value
  check(
    Math.abs(u.r - murkLinear.r) < 1e-12 && Math.abs(u.g - murkLinear.g) < 1e-12 && Math.abs(u.b - murkLinear.b) < 1e-12,
    'uMurk carries the linear form, matching where the water shader mixes it'
  )
}

// And setAir puts the sRGB one on both ends of the ramp -- both, because the
// in-scatter gradient between them is a model of kilometres of atmosphere and
// there is no such gradient inside a lake.
{
  lighting.setAir(murkAir)
  const near = lighting.uniforms.uAirNear.value
  const farAir = lighting.uniforms.uAirFar.value
  check(
    near.equals(murkAir) && farAir.equals(murkAir),
    'setAir collapses both ends of the aerial ramp onto the murk'
  )
}

// A capture into a linear target gets the ramp ends in linear, and the canvas
// gets its sRGB ones back afterwards, bit for bit.
{
  const near = lighting.uniforms.uAirNear.value
  const farAir = lighting.uniforms.uAirFar.value
  near.set(0.5, 0.25, 0.75)
  farAir.set(0.8, 0.6, 0.4)
  const srgbNear = near.clone()
  const srgbFar = farAir.clone()
  lighting.airToLinear()
  const lin = (c) => new THREE.Color().setRGB(c.x, c.y, c.z, THREE.SRGBColorSpace)
  const ln = lin(srgbNear)
  const lf = lin(srgbFar)
  check(
    Math.abs(near.x - ln.r) < 1e-9 && Math.abs(near.z - ln.b) < 1e-9 && Math.abs(farAir.y - lf.g) < 1e-9,
    'airToLinear decodes both ramp ends from sRGB to linear',
    `near ${near.x.toFixed(4)} vs ${ln.r.toFixed(4)}`
  )
  check(near.x < srgbNear.x && farAir.x < srgbFar.x, 'and linear is darker than the sRGB it came from')
  lighting.airToOutput()
  check(near.equals(srgbNear) && farAir.equals(srgbFar), 'and airToOutput restores the sRGB pair exactly')
}

// --- 3. the visibility --------------------------------------------------------
//
// The aerial chunk keeps `exp( -(d * density)^2 )` of a surface's own colour.
// Restated here from lighting.js rather than imported, because the point is to
// catch the day the two disagree.
const keepAt = (d, density) => Math.exp(-((d * density) ** 2))

{
  const density = murkDensity(UNDERWATER.visibility)
  const keep = keepAt(UNDERWATER.visibility, density)
  check(
    keep < 0.03,
    `a surface at ${UNDERWATER.visibility} m is essentially gone`,
    `${(keep * 100).toFixed(1)}% of its own colour left`
  )
  // The other side of the same claim: this is a CEILING, not a wash. Close up
  // she must still see things, or the murk is just a blindfold.
  check(
    keepAt(UNDERWATER.visibility * 0.1, density) > 0.9,
    'and one at a tenth of that distance is essentially untouched',
    `${(keepAt(UNDERWATER.visibility * 0.1, density) * 100).toFixed(1)}% left`
  )
}

// The square is INSIDE the exponent, so the density goes as 1/d and halving the
// visibility exactly doubles it. This is the relation that a rewrite into a
// lerp between two authored densities would break.
check(
  Math.abs(murkDensity(10) - 2 * murkDensity(20)) < 1e-12,
  'halving the visibility exactly doubles the density',
  `${murkDensity(10).toFixed(6)} vs ${(2 * murkDensity(20)).toFixed(6)}`
)

// A visibility of 0 or less is a division that would sail through as Infinity
// and blank the world, so it is refused rather than computed.
{
  let threw = false
  try {
    murkDensity(0)
  } catch {
    threw = true
  }
  check(threw, 'and a visibility of zero is refused rather than turned into Infinity')
}

// It is a genuinely different medium from air, not the haze turned up a bit.
// The palette's daylight haze is around 1/4000 per metre; anything within an
// order of magnitude of that is not water.
check(
  murkDensity(UNDERWATER.visibility) > 100 * (1 / 4000),
  'the murk extinguishes at least 100x faster than daylight haze',
  `${murkDensity(UNDERWATER.visibility).toFixed(4)} /m vs ${(1 / 4000).toFixed(6)} /m`
)

// --- 4. the fog target --------------------------------------------------------
//
// Read out of the string that compiles, not restated. §11's exemption sends a
// distant water pixel to the horizon sky; the submerged branch has to send it
// to the murk instead, and the two must be one expression rather than two
// copies of the fade.
check(
  frag.includes('mix( skyRadiance( horizonDir, 0.0 ) * uReflTint, uMurk, uSubmerged )'),
  "water's fog exemption is itself switched off underwater"
)
// Exactly three mentions: the definition, one call on the top face, one on the
// underside. Both faces fade from the one expression, so they cannot recede at
// different rates, and this count is what notices a fourth call -- or a second
// fade authored beside the first -- appearing on either side.
check(
  (frag.match(/waterFogAmt\(\)/g) || []).length === 3,
  'and both faces fade from that one expression',
  `${(frag.match(/waterFogAmt\(\)/g) || []).length} mentions; expected the definition plus one call per face`
)

// The underside must not be reachable while she is dry: a back face is also
// what a lake looks like from inside a cave, and there the ordinary shading is
// still the right answer.
check(
  frag.includes('uSubmerged > 0.5 && ! gl_FrontFacing'),
  'and the underside path needs BOTH the facing and the submerged flag'
)

// --- 5. the flag ---------------------------------------------------------------

check(water.uniforms.uSubmerged.value === 0, 'the water starts dry')
water.setSubmerged(true)
check(water.uniforms.uSubmerged.value === 1, 'setSubmerged(true) raises the flag')
water.setSubmerged(false)
check(water.uniforms.uSubmerged.value === 0, 'and setSubmerged(false) clears it')

// --- 6. the knobs ---------------------------------------------------------------
//
// Cheap sanity on the four that would produce a plausible-but-wrong view rather
// than an obviously broken one.
check(
  UNDERWATER.light < 1 && UNDERWATER.ambient < 1,
  'both lights are dimmed rather than brightened underwater',
  `light ${UNDERWATER.light}, ambient ${UNDERWATER.ambient}`
)
check(
  UNDERWATER.tint > 0 && UNDERWATER.tint <= 1,
  'and their colours are pulled toward the murk, not merely turned down'
)
check(
  UNDERWATER.skyGain > 0 && UNDERWATER.skyGain < 1,
  'the sky loses light on its way down through the surface',
  `skyGain ${UNDERWATER.skyGain}`
)
{
  const u = water.uniforms.uUnder.value
  check(
    u.x === UNDERWATER.skyGain && u.y === UNDERWATER.distort && u.z === UNDERWATER.veil,
    'and the underside uniform carries all three of its authored knobs'
  )
  const w = water.uniforms.uWindow.value
  check(
    w.x === UNDERWATER.windowShut && w.y === UNDERWATER.windowOpen,
    'as does the window uniform, shut edge first because smoothstep wants it that way'
  )
}

// SNELL'S WINDOW, which is the difference between a surface and a blue plane.
//
// The first pass used a squared cosine and the surface read as opaque from
// anywhere but straight up. The numbers below are the ones that made it a
// window: the real cone is 48.6 degrees off vertical, cos 48.6 = 0.661, and both
// smoothstep edges have to straddle it or the fade is centred somewhere the eye
// does not expect. A soft edge rather than the hard one physics has, because a
// crisp boundary inside a rippling surface crawls.
{
  const CRITICAL = Math.cos((48.6 * Math.PI) / 180)
  check(
    UNDERWATER.windowShut < CRITICAL && UNDERWATER.windowOpen > CRITICAL,
    'the window fade straddles the real critical angle rather than sitting to one side of it',
    `${UNDERWATER.windowShut} .. ${UNDERWATER.windowOpen} around cos 48.6 = ${CRITICAL.toFixed(3)}`
  )
  // The failure this exists to catch is the one already made once: a curve that
  // is technically nonzero at the critical angle but is down in the noise there.
  const atCritical = (() => {
    const t = Math.min(1, Math.max(0, (CRITICAL - UNDERWATER.windowShut) / (UNDERWATER.windowOpen - UNDERWATER.windowShut)))
    return t * t * (3 - 2 * t)
  })()
  check(atCritical > 0.5, 'and is more than half open where the physics says the window is', `${(atCritical * 100).toFixed(0)}% at 48.6 degrees`)
  check(
    UNDERWATER.veil > 0 && UNDERWATER.veil < 0.5,
    'a veil of murk is left over the window, so it reads as a surface and not a hole',
    `veil ${UNDERWATER.veil}`
  )
  // Two degrees of bend is a pane of glass. The wave normals here tilt by about
  // 0.1, so anything at or under 1 is invisible as a ripple.
  check(UNDERWATER.distort > 1, 'and the waves bend the view by more than their own slope', `distort ${UNDERWATER.distort}`)
}

// THE CEILING FADES TO MURK AT THE SAME RATE AS THE BED, in full and from the
// same expression, and this pair of checks is what stops the fade being dropped
// or reduced the next time someone reasons that the surface is the boundary of
// the medium rather than a thing in it.
//
// Light off the far rim crosses the same water as light off the far bank. Left
// crisp, the rim reads as a plane intersecting fogged terrain; given a PARTIAL
// share it stays part-crisp and part-grey, which was tried and was worse than
// either. What stops the full fade reading as fog with ripples is tirLit, which
// lights the near ceiling above the murk it recedes to -- checked below.
{
  const under = frag.slice(frag.indexOf('! gl_FrontFacing'), frag.indexOf('vec3 R = reflect'))
  check(
    /ceiling = mix\( ceiling, uMurk, waterFogAmt\(\) \)/.test(under),
    'the underside takes the full murk fade toward uMurk, from the shared expression'
  )
  check(/vec4\( ceiling, 1\.0 \)/.test(under), 'and it stays fully opaque whatever WATER.clarity says')
}

// THE MIRROR OUTSIDE SNELL'S WINDOW, which has to be two things at once.
//
// It has to RIPPLE: a mirror of uniform murk is a wall of one colour, and the
// sheen is what puts the wave field back into it, so it has to LIGHTEN. Below 1
// would darken, and 1 exactly is the flat wall again.
//
// And it has to be LIT. Painted uMurk flat it came out the exact colour of the
// water in front of it and vanished into its own medium -- the "grayscale murky
// mist" the ceiling used to read as. tirLit is the share of downwelling light
// that puts it back, and both ends are excluded: 0 is the flat fog colour again,
// 1 is the sky itself, which reads as the window never closing.
{
  check(
    UNDERWATER.tir > 1,
    'the mirror outside the window brightens with the facets rather than sitting flat',
    `tir ${UNDERWATER.tir}`
  )
  check(
    UNDERWATER.tirLit > 0 && UNDERWATER.tirLit < 1,
    'and it carries some of the downwelling light, so it is not the fog colour',
    `tirLit ${UNDERWATER.tirLit}`
  )
  const t = water.uniforms.uTir.value
  check(t.x === UNDERWATER.tir && t.y === UNDERWATER.tirLit, 'and the uniform carries both mirror knobs')
  // Wired into the source. Asserted on the text because a shader that quietly
  // stopped doing either looks like a slightly different shade of blue rather
  // than like a failure.
  check(/mix\( uMurk, through, uTir\.y \) \* mix\( 1\.0, uTir\.x, lean \)/.test(frag), 'and the sheen is both at once')
  // The veil over the window is made of the same sheen as the mirror around it.
  // Raw murk there draws the boundary between the two as a visible edge.
  check(/mix\( sheen, mix\( through, sheen, uUnder\.z \), window \)/.test(frag), 'and the window is veiled with that same sheen')
}

// THE WORLD PROBE, which is what finally puts the trees behind the surface.
//
// wlBlocked is a terrain horizon map and a spruce is not terrain, so the ridges
// came through Snell's window and the bank in front of them did not. The capture
// answers the other half. Two things about how the two are combined are worth
// pinning down, because both fail quietly:
//
//   MAX, not a mix. The capture has 128 pixels a face and a far ridge occupies
//   very few of them; letting its zero argue against a horizon map that is
//   certain would punch holes of sky through mountains.
//   ONE FUNCTION, both sides. The top face and the underside are two views of a
//   single surface and cannot be allowed to disagree about where the land is.
{
  check(
    water.uniforms.uWorldA.value === worldProbe.textureA
      && water.uniforms.uWorldB.value === worldProbe.textureB
      && worldProbe.textureA !== worldProbe.textureB,
    "the water samples the probe's own two cubes, by reference, and they are two"
  )
  // Alpha is half the payload -- it is what "no land along this ray" means -- so
  // an RGB format would silently make every direction land. Both cubes, because
  // the ping-pong means either one can be the one being displayed.
  check(
    worldProbe.a.texture.format === THREE.RGBAFormat && worldProbe.b.texture.format === THREE.RGBAFormat,
    'and both carry the alpha channel the coverage lives in'
  )
  // A hillside in front of a tree has to win, which the sky probe never needed.
  check(
    worldProbe.a.depthBuffer === true && worldProbe.b.depthBuffer === true,
    'and a depth buffer, unlike the sky probe, because this capture occludes itself'
  )
  check(
    /uWorldFade <= 0\.0 \? texture\( uWorldA, dir \)/.test(frag)
      && /mix\( texture\( uWorldA, dir \), texture\( uWorldB, dir \), uWorldFade \)/.test(frag),
    'and the shader mixes between them rather than cutting, with both ends branched out'
  )
  check(
    water.uniforms.uWorldMix.value === WORLD_PROBE.mix,
    'and the knob that fades it back toward the flat silhouette reaches the shader',
    `mix ${WORLD_PROBE.mix}`
  )
  check(
    /vec4 worldSilhouette\( vec3 dir \)/.test(frag),
    'the land along a ray is one function, so the two sides of the surface cannot disagree'
  )
  check(
    /max\( ridge, cover \)/.test(frag),
    'and it takes the MAX of the horizon map and the capture rather than mixing them',
    'a 128 px capture must not be able to argue a mountain away'
  )
  check(
    /vec4 land = worldSilhouette\( dir \);/.test(frag) && /vec4 land = worldSilhouette\( R \);/.test(frag),
    'and both the underside and the top face actually call it'
  )
  // The capture is taken above the SURFACE, not at the eye. A cube sampled by a
  // surface at water level but taken from two metres up puts the horizon in the
  // wrong place, and a grazing reflection is made of nothing but the horizon.
  check(
    WORLD_PROBE.height > 0 && WORLD_PROBE.height < 1,
    'the capture is taken just above the water rather than at her eye',
    `${WORLD_PROBE.height} m`
  )
  // Standing still it ticks over slowly; walking re-anchors. The one thing that
  // must hold is that the slow path is genuinely slow -- this is a full scene
  // traversal per face, and the whole argument for affording it is the cadence.
  check(
    WORLD_PROBE.refreshFrames >= 50,
    'and it refreshes slowly while she stands still, which is what makes it affordable',
    `five faces every ${WORLD_PROBE.refreshFrames} frames`
  )
  check(
    WORLD_PROBE.moveRefresh > 0 && WORLD_PROBE.moveRefresh < 50,
    'but re-anchors once she has walked far enough for the parallax to show',
    `${WORLD_PROBE.moveRefresh} m`
  )
}

// --- the anchor floor and the cross-fade, driven for real -------------------
//
// Both of these are scheduling, and scheduling is where this file's silent
// failures live: a probe that captures from inside a hillside renders perfectly
// and returns grey, and a fade that never starts is indistinguishable from a
// fade that is not implemented. So drive the real update() against a stub
// renderer rather than reading the constants back.
{
  const scene2 = new THREE.Scene()
  const written = []
  const stub = {
    coordinateSystem: THREE.WebGLCoordinateSystem,
    xr: { enabled: true },
    getRenderTarget: () => null,
    getClearColor: (c) => c.setHex(0),
    getClearAlpha: () => 1,
    setClearColor: () => {},
    setRenderTarget: (t, face) => written.push({ t, face }),
    clear: () => {},
    render: () => {},
  }
  const DT = 1 / 72
  const head = new THREE.Vector3()

  // SHE IS STANDING ON A BANK 5 m ABOVE A LAKE, and the lake's dilated polygon
  // reaches under her feet, so levelAt answers with the lake's still level. The
  // old code anchored there and buried the camera in the bank.
  const p1 = new WorldProbe()
  head.set(0, 105, 0)          // eye 5 m over a lake surface at 100
  p1.update(stub, scene2, head, 100, DT)
  check(
    p1.anchor.y >= head.y - WORLD_PROBE.duck - 1e-6,
    'standing on a bank, the capture stays near her rather than dropping to the lake surface',
    `anchor y ${p1.anchor.y.toFixed(2)} against her eye at ${head.y} and the lake at 100`
  )

  // AND THE FLICKER IS GONE. Walking the shoreline, that same polygon test flips
  // between the lake level and null with every step. Both must now land on the
  // same anchor, or the probe re-anchors on a proxy for her position -- which is
  // exactly what "it jumps around a little bit randomly" was.
  const onLake = new WorldProbe()
  const onLand = new WorldProbe()
  onLake.update(stub, scene2, head, 100, DT)
  onLand.update(stub, scene2, head, null, DT)
  check(
    Math.abs(onLake.anchor.y - onLand.anchor.y) < 1e-6,
    'and the in-polygon and out-of-polygon answers agree above the water, so a shoreline step cannot re-anchor',
    `${onLake.anchor.y.toFixed(2)} either way`
  )

  // UNDER THE WATER the floor must get out of the way -- this is the case the
  // surface offset was written for and the one the shader actually samples.
  const p2 = new WorldProbe()
  head.set(0, 96, 0)           // her eye 4 m down
  p2.update(stub, scene2, head, 100, DT)
  check(
    Math.abs(p2.anchor.y - (100 + WORLD_PROBE.height)) < 1e-6,
    'but swimming under it, the capture still sits just above the surface',
    `anchor y ${p2.anchor.y.toFixed(2)}`
  )

  // THE FIRST CUBE SNAPS. There is nothing to fade from at load, and fading in
  // from an empty target would show a second of flat silhouette every reload.
  const p3 = new WorldProbe()
  head.set(0, 105, 0)
  for (let k = 0; k < 5; k++) p3.update(stub, scene2, head, null, DT)
  check(
    p3.blend === p3.live && p3.filling < 0,
    'the first cube snaps in rather than fading up from an empty one',
    `blend ${p3.blend}, live ${p3.live}`
  )

  // NOW MOVE HER. Past moveRefresh, so the second cube fills -- and the shader's
  // blend must WALK rather than jump, taking about fadeSeconds to get there.
  head.set(0, 105, WORLD_PROBE.moveRefresh + 5)
  const wasLive = p3.live
  const walk = []
  for (let k = 0; k < 5; k++) p3.update(stub, scene2, head, null, DT)   // fill the spare
  // Parity-agnostic on purpose: which of the two cubes is live alternates, and
  // pinning it to a number would make this a test of the ping-pong's phase
  // rather than of the invariant, which is that the fill lands in the cube that
  // was NOT being shown and the blend has not started moving yet.
  check(
    p3.live === wasLive ^ 1 && p3.blend === wasLive && p3.filling < 0,
    'a re-anchor fills the OTHER cube and only then starts the fade',
    `live ${wasLive} -> ${p3.live}, blend still at ${p3.blend}`
  )
  for (let k = 0; k < Math.ceil(WORLD_PROBE.fadeSeconds / DT) + 4; k++) {
    p3.update(stub, scene2, head, null, DT)
    walk.push(p3.blend)
  }
  const biggestStep = Math.max(...walk.map((v, i) => (i ? Math.abs(v - walk[i - 1]) : 0)))
  check(
    p3.blend === p3.live && biggestStep < 0.06,
    'and it arrives, one small step at a time, rather than cutting',
    `${walk.length} frames, biggest single step ${biggestStep.toFixed(3)}`
  )

  // FLYING. Crossing moveRefresh every frame must not queue a burst per crossing
  // -- there is one spare cube, so honouring them all would mean every handover
  // ending in the snap this exists to remove. Deferring is the whole policy.
  const p4 = new WorldProbe()
  head.set(0, 105, 0)
  for (let k = 0; k < 5; k++) p4.update(stub, scene2, head, null, DT)
  const before = p4.captures
  for (let k = 0; k < 200; k++) {
    head.set(0, 105, k * (WORLD_PROBE.moveRefresh + 1))
    p4.update(stub, scene2, head, null, DT)
  }
  const bursts = (p4.captures - before) / 5
  const ceiling = 200 * DT / WORLD_PROBE.fadeSeconds + 1
  check(
    bursts <= ceiling,
    'and flying past the re-anchor distance every frame is rate-limited to one handover per fade',
    `${bursts} bursts in 200 frames, ceiling ${ceiling.toFixed(1)}`
  )

  // STANDING STILL. The timed refresh is the same handover as a re-anchor: five
  // faces into the cube that is NOT on screen, then a fade. A face written into
  // the live cube is a fifth of the reflection cutting in one frame, which with
  // wind in the trees is a visible blink.
  const p7 = new WorldProbe()
  head.set(0, 105, 0)
  for (let k = 0; k < 5; k++) p7.update(stub, scene2, head, null, DT)
  const shown = p7.live
  const anchorBefore = p7.anchor.clone()
  written.length = 0
  let firstFade = -1
  for (let k = 0; k < WORLD_PROBE.refreshFrames + 5; k++) {
    p7.update(stub, scene2, head, null, DT)
    if (firstFade < 0 && p7.fade !== shown) firstFade = k
  }
  const liveTarget = shown === 0 ? p7.a : p7.b
  const faces = written.filter((w) => w.t !== null)   // the restore binds null
  check(
    faces.length === 5 && faces.every((w) => w.t !== liveTarget),
    'standing still, the timed refresh fills the cube that is not on screen',
    `${faces.length} faces written, ${faces.filter((w) => w.t === liveTarget).length} of them into the live cube`
  )
  check(
    p7.live === shown ^ 1 && firstFade > 0 && p7.fade !== p7.live && p7.anchor.equals(anchorBefore),
    'and then fades over to it from the same anchor, rather than cutting',
    `live ${shown} -> ${p7.live}, fade began ${firstFade} frames in, at ${p7.fade.toFixed(3)} now`
  )

  // THE VANTAGE. The host may put the capture out on the water; when it does,
  // the anchor is the point it named, and the re-anchor distance is still
  // measured from HER, or a capture 10 m out would re-anchor after two steps.
  const p5 = new WorldProbe()
  let asked = 0
  p5.setVantage((h, out) => { asked++; out.set(h.x + 10, 100 + WORLD_PROBE.height, h.z); return true })
  head.set(0, 105, 0)
  for (let k = 0; k < 5; k++) p5.update(stub, scene2, head, 100, DT)
  check(
    asked === 1 && p5.anchor.x === 10 && Math.abs(p5.anchor.y - (100 + WORLD_PROBE.height)) < 1e-6,
    'a vantage puts the capture where the host says, asked once per re-anchor',
    `asked ${asked}x, anchor (${p5.anchor.x}, ${p5.anchor.y.toFixed(2)}, ${p5.anchor.z})`
  )
  head.set(0, 105, WORLD_PROBE.moveRefresh - 1)
  for (let k = 0; k < 5; k++) p5.update(stub, scene2, head, 100, DT)
  check(
    asked === 1,
    'and walking short of moveRefresh from where she stood does not re-anchor, however far out the capture sits',
    `asked ${asked}x after ${WORLD_PROBE.moveRefresh - 1} m`
  )
  const p6 = new WorldProbe()
  p6.setVantage(() => false)
  head.set(0, 105, 0)
  p6.update(stub, scene2, head, 100, DT)
  check(
    Math.abs(p6.anchor.y - p1.anchor.y) < 1e-6 && p6.anchor.x === 0 && p6.anchor.z === 0,
    'a vantage that finds no water falls back to her own x/z under the duck floor',
    `anchor y ${p6.anchor.y.toFixed(2)}`
  )
}

// The five things the capture must not contain, asserted at the call site. Each
// is a bug that draws perfectly: the water reflecting itself, or a sky dome
// filling every face with alpha 1 so that "is there land along this ray" answers
// yes everywhere and the lake turns to flat slate.
for (const [label, file] of [['v2', 'src/v2/main.js']]) {
  const src = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  check(
    /worldProbe\.exclude\(\s*water\.group,\s*sky\.mesh,\s*stars\.points,\s*aurora\.mesh\s*\)/.test(src),
    `${label} keeps the water, the dome, the stars and the aurora out of the world capture`
  )
  check(
    /worldProbe\.update\(renderer, scene, headTmp/.test(src)
      && src.indexOf('worldProbe.update') > src.indexOf('probe.update(renderer'),
    `${label} runs it before the main render, alongside the sky probe`
  )
}


// ...and the horizon map is still in it. The capture reaches as far as its 128
// pixels reach; the horizon map is what carries the mountains behind that, and a
// worldSilhouette that quietly stopped calling it would look like a slightly
// brighter sky rather than like a failure.
check(
  /vec4 worldSilhouette[\s\S]*?wlBlocked\( vWorldPos\.xz, dir \)[\s\S]*?^        \}/m.test(frag),
  'and the terrain horizon map is still consulted alongside it, for the range the capture cannot reach'
)

// --- 7. the eye query ----------------------------------------------------------
//
// levelAt answers two different questions and the submersion test wants the
// second one. The scatter asks where the ground is WET and gets the authored
// footprint; the eye asks whether it is under the POLYGON, and a river's polygon
// is widened past its footprint to bury its edge under the bank. Between the two
// is a band about a metre wide down each side of every stream where she is
// visibly under the surface and the world says dry -- which does not look like a
// bug, it looks like the murk being late.
//
// Built on the prototype rather than through the constructor because what is
// being checked is one pure function of the index, and standing up a Layers
// document to reach it would test the document. The four fields below are
// exactly what levelAt reads.
{
  const ws = Object.create(WaterSurfaces.prototype)
  ws.lakeBoxes = []
  // One river segment, 2 m half-width, running +x at y = 100.
  ws.idxPts = new Float32Array([0, 100, 0, 2, 10, 100, 0, 2])
  ws.idxTail = new Uint8Array([0, 1])
  ws.idxRun = new Int32Array([0, 0])
  ws.buckets = new Map([[bucketKeyFor(0, 0), [0]]])

  const widened = 2 + Math.min(RIVER_WIDEN, 2 * RIVER_WIDEN_FRAC)
  // Just outside the authored half-width, comfortably inside the drawn ribbon.
  const probe = (2 + widened) / 2

  check(ws.levelAt(5, 0) === 100 && ws.levelAt(5, 0, true) === 100, 'mid-channel is wet on both queries')
  check(
    ws.levelAt(5, probe) === null && ws.levelAt(5, probe, true) === 100,
    'and the drawn query reaches the widened ribbon where the authored one stops',
    `${probe.toFixed(3)} m out, authored half-width 2, drawn ${widened.toFixed(3)}`
  )
  // The widening is the ribbon's OWN rule, read from the ribbon's own constants.
  // A query that widened by a flat RIVER_WIDEN would be right on a wide river
  // and half a metre wrong on a brook, which is where she is most likely to be
  // standing at the edge of one.
  check(
    ws.levelAt(5, widened + 1e-3, true) === null,
    'and it stops exactly where ribbonVertices stops, fraction and all'
  )
  // The scatter's answer must not have moved: everything already placed in the
  // world was placed against it.
  check(ws.levelAt(5, 2 + 1e-3) === null, 'while the authored query is unchanged')
}

// --- 8. the caustics -------------------------------------------------------------
//
// The net on the bed. What can be checked without a GPU is the plumbing, and the
// plumbing has one failure that is worse than the rest: a gain left set on dry
// land, which paints moving threads of light across a hillside.
{
  const l = new WorldLighting()
  check(l.uniforms.uCaustic.value.x === 0, 'the caustic net rests OFF, and off is a gain of zero')

  l.setCaustic(UNDERWATER.caustic, UNDERWATER.causticScale, 100, UNDERWATER.causticFade, 3)
  const u = l.uniforms.uCaustic.value
  check(u.x === UNDERWATER.caustic, 'setCaustic raises the gain')
  // The two reciprocals are taken HERE rather than in the shader, and getting
  // either the wrong way up gives a net that is right at one scale and silently
  // wrong at every other: 1/1.6 and 1.6 are both plausible-looking numbers.
  check(
    Math.abs(u.y - 1 / UNDERWATER.causticScale) < 1e-12 && Math.abs(u.w - 1 / UNDERWATER.causticFade) < 1e-12,
    'and hands the shader reciprocals, so the knobs stay in metres',
    `scale ${UNDERWATER.causticScale} m -> ${u.y.toFixed(4)}, fade ${UNDERWATER.causticFade} m -> ${u.w.toFixed(4)}`
  )
  check(u.z === 100, 'and carries the WATER surface, not the eye')

  l.setCaustic(0, UNDERWATER.causticScale, 0, UNDERWATER.causticFade, 3)
  check(l.uniforms.uCaustic.value.x === 0, 'and a gain of zero puts it back, with no second flag to clear')

  // Zero or negative would divide to Infinity and hand the shader a fade length
  // of nothing, i.e. a net that exists only in the surface plane -- invisible,
  // and indistinguishable from the whole feature being switched off.
  for (const [label, fn] of [
    ['a fade of zero', () => l.setCaustic(1, 1, 0, 0, 0)],
    ['a scale of zero', () => l.setCaustic(1, 0, 0, 1, 0)],
  ]) {
    let threw = false
    try {
      fn()
    } catch {
      threw = true
    }
    check(threw, `${label} is refused rather than turned into Infinity`)
  }
}

check(
  UNDERWATER.caustic > 0 && UNDERWATER.causticFade < UNDERWATER.visibility,
  'the net dissolves with depth sooner than the murk hides it',
  `fade ${UNDERWATER.causticFade} m under a ${UNDERWATER.visibility} m ceiling`
)

// NIGHT. The net dims by four fifths after dark rather than switching off: a
// moon over open water really does cast this, and the two ends have to stay
// distinguishable or the knob is a bool wearing a float's clothes.
check(
  UNDERWATER.causticNight > 0 && UNDERWATER.causticNight < 1,
  'the caustic net dims at night rather than going out',
  `${(UNDERWATER.causticNight * 100).toFixed(0)}% of its daylight strength`
)
// The ramp main.js applies, restated here so a sign slip in it is caught: it
// reads the SUN's elevation, from fully out at -6 degrees to fully lit at +4,
// and must be monotone. Reading state.lightIntensity instead would BRIGHTEN the
// net at nightfall, because that number swaps to the moon at exactly -6.
{
  const dayness = (elevDeg) => Math.max(0, Math.min(1, (elevDeg + 6) / 10))
  const gain = (elevDeg) =>
    UNDERWATER.caustic * (UNDERWATER.causticNight + (1 - UNDERWATER.causticNight) * dayness(elevDeg))
  check(
    gain(-20) < gain(-1) && gain(-1) < gain(20),
    'and the ramp between the two is monotone in the SUN, so nothing brightens at dusk',
    `${gain(-20).toFixed(3)} -> ${gain(-1).toFixed(3)} -> ${gain(20).toFixed(3)}`
  )
  check(
    Math.abs(gain(-20) - UNDERWATER.caustic * UNDERWATER.causticNight) < 1e-9 &&
      Math.abs(gain(20) - UNDERWATER.caustic) < 1e-9,
    'and it reaches both ends exactly rather than asymptotically'
  )
}

// --- 9. the air the capture is taken in ------------------------------------------
//
// The world capture is anchored 20 cm ABOVE the surface -- it is a picture of
// the world seen from the air -- but on a frame where she is under, everything
// that decides what air looks like has already been sunk to the murk: fog
// density at the 20 m ceiling, both ends of the aerial ramp on one colour, both
// lights dimmed and pulled toward blue-grey. Capture through that and the cube
// comes back with its distance flattened into haze and its near props grey, and
// that cube is precisely what shades the underside of the surface. The murk
// arrives on the sky she is looking up at through the water, having already
// been applied to the water she is looking through -- twice, in series, which
// is what "the distant props fade into a murky light-blue-gray haze" was.
//
// The fix is two closures around one render. What can go wrong with it is not
// the colour -- it is the BRACKETING, and every way of getting that wrong draws
// without complaint.
{
  const scene3 = new THREE.Scene()
  // A REAL BACKGROUND COLOUR ON THE STUB SCENE, because the crash this block now
  // guards was in the interaction between two state swaps rather than in either
  // one. The probe sets scene.background to null for the length of the capture
  // -- alpha zero is its payload -- and sinkAir writes the murk INTO
  // scene.background. Nest them the wrong way round and leave() runs against a
  // null and throws the first time she ducks under. A stub scene left with the
  // default background of null cannot see that, so this one has a colour and
  // the fake hook touches it exactly the way the real one does.
  scene3.background = new THREE.Color(0x000000)
  // `air` is a boolean standing in for the whole atmosphere: true means the
  // palette's, false means the murk. The stub renderer records what it was at
  // the moment render() was called, which is the only instant that matters.
  let air = false
  const sawAir = []
  const stub3 = {
    coordinateSystem: THREE.WebGLCoordinateSystem,
    xr: { enabled: true },
    getRenderTarget: () => null,
    getClearColor: (c) => c.setHex(0),
    getClearAlpha: () => 1,
    setClearColor: () => {},
    setRenderTarget: () => {},
    clear: () => {},
    render: () => sawAir.push(air),
  }
  const hook = {
    enter: () => {
      air = true
      if (scene3.background === null) throw new Error('enter() ran with scene.background nulled by the probe')
    },
    leave: () => {
      air = false
      // The line that actually threw. Deliberately unguarded: a hook that
      // tiptoes around the probe's null is not the fix, the ordering is.
      scene3.background.copy(murkLinear)
    },
  }
  const DT3 = 1 / 72
  const h3 = new THREE.Vector3(0, 99, 0)

  const p5 = new WorldProbe()
  // Caught, so that the ordering bug reports as a failed check and the rest of
  // this file still runs. Left uncaught it takes the whole gate down with a
  // stack trace, which is the same information told worse.
  let threw = null
  try {
    for (let k = 0; k < 40; k++) p5.update(stub3, scene3, h3, 100, DT3, hook)
  } catch (e) {
    threw = e
  }
  check(threw === null, 'the hook survives forty frames of capture', threw ? threw.message : '')

  check(
    sawAir.length > 0 && sawAir.every(Boolean),
    'every face of the world capture is rendered in air, not in the murk of the frame around it',
    `${sawAir.filter(Boolean).length} of ${sawAir.length} captures`
  )
  // AND IT IS PUT BACK. A leave() that is skipped -- an early return between the
  // two, a throw, a second render slipped in -- leaves the palette's fog and the
  // undimmed lights standing for the MAIN render, and the whole underwater look
  // vanishes for that frame. One frame in thirty is a flicker nobody can trace.
  check(air === false, 'and the murk is put back before the frame is drawn, every time')
  // Reached only if neither closure threw, which is the assertion: both run
  // outside the probe's own swap, so the scene they are handed is the scene the
  // frame has rather than the half-dismantled one the capture needs.
  check(
    scene3.background !== null && scene3.background.equals(murkLinear),
    'and both halves of the hook see a whole scene, not the one the probe took apart'
  )

  // A frame that captures nothing must not touch the atmosphere at all: between
  // bursts the probe returns early, and paying for a fog rewrite and a lighting
  // update on those frames would be a cost this feature does not have.
  const p6 = new WorldProbe()
  p6.update(stub3, scene3, h3, 100, DT3, hook)   // burst starts: 1 face
  let entries = 0
  const counting = {
    enter: () => { entries++; hook.enter() },
    leave: hook.leave,
  }
  const before6 = p6.captures
  for (let k = 0; k < 4; k++) p6.update(stub3, scene3, h3, 100, DT3, counting)
  check(
    entries === p6.captures - before6,
    'and the hook runs once per captured face and not once per frame',
    `${entries} entries for ${p6.captures - before6} faces`
  )

  // The hook is optional and the default is the frame's own air, so phase A and
  // every dry frame in v2 are unchanged -- and unchanged is checked by driving
  // it, not by reading the default.
  const p7 = new WorldProbe()
  const clean = sawAir.length
  p7.update(stub3, scene3, h3, null, DT3)
  check(sawAir.length > clean, 'and a probe called without a hook still captures', `${sawAir.length - clean} face`)
}

// The call site. The hook goes in on every frame -- the linear ramp ends are
// wanted for every capture -- and the hook itself lifts the murk only while
// she is under, in the order that keeps the lift's palette rewrite from undoing
// the linearisation: lift, then linear; output, then sink.
{
  const v2 = fs.readFileSync(new URL('../src/v2/main.js', import.meta.url), 'utf8')
  check(
    /worldProbe\.update\(renderer, scene, headTmp, waterY, dt, airHook\)/.test(v2),
    'v2 hands the capture the air hook on every frame'
  )
  const hook = /const airHook = \{([\s\S]*?)\n\}/.exec(v2)
  check(hook !== null, 'v2 has an airHook')
  if (hook) {
    const enter = /enter: \(\) => \{([\s\S]*?)\n  \}/.exec(hook[1])
    const leave = /leave: \(\) => \{([\s\S]*?)\n  \}/.exec(hook[1])
    check(
      enter !== null && enter[1].indexOf('if (submerged) liftAir(') < enter[1].indexOf('lighting.airToLinear()'),
      'and enter lifts the murk (only when under) BEFORE it linearises the ramp'
    )
    check(
      leave !== null && leave[1].indexOf('lighting.airToOutput()') < leave[1].indexOf('if (submerged) sinkAir()'),
      'and leave restores the ramp BEFORE it sinks the murk back (only when under)'
    )
  }
  // SINK IS NOT IDEMPOTENT and lift is the thing that makes that safe. The light
  // lines multiply -- they are dimming the palette's own answer for this hour,
  // not landing on a fixed number -- so sinking twice with no lift between dims
  // twice, and the second frame of a swim would be darker than the first and the
  // third darker again. What stops that is that lift is an ABSOLUTE write of the
  // same values applySky sets, so it is a real inverse and not an undo.
  const lift = /function liftAir\(state\) \{([\s\S]*?)\n\}/.exec(v2)
  check(lift !== null, 'v2 has a liftAir that restores the palette')
  if (lift) {
    check(
      !/[*+/-]=/.test(lift[1]),
      'and it assigns rather than accumulating, so it is an inverse and not an undo',
      (lift[1].match(/.*[*+/-]=.*/g) ?? []).join(' | ')
    )
    for (const line of ['sun.intensity = state.lightIntensity', 'hemi.intensity = state.hemiIntensity',
      'scene.fog.density = state.hazeDensity', 'lighting.update(state)']) {
      check(lift[1].includes(line), `and it restores ${line.split(' ')[0]}`)
    }
  }
  // One sink, two callers. A second copy of those six lines is a second place
  // for a knob to be forgotten, and the copy that is forgotten is always the one
  // nobody reads.
  const sinks = (v2.match(/sinkAir\(\)/g) ?? []).length
  check(sinks >= 2 || /leave: sinkAir/.test(v2), 'and the murk has one implementation, shared by the frame and the hook')
}

// --- 10. the current ------------------------------------------------------------
//
// A slow lateral push while she is under. Two things about it can be wrong in a
// way that only shows up minutes later, and both are arithmetic rather than
// looks, so both belong here.
{
  const v = new THREE.Vector3()
  check(
    Math.abs(CURRENT.slowShare + (1 - CURRENT.slowShare) - 1) < 1e-12 &&
      CURRENT.slowShare > 0.5 && CURRENT.slowShare < 1,
    'the two swings share one amplitude, and the long one carries most of it',
    `${CURRENT.slowShare} / ${(1 - CURRENT.slowShare).toFixed(2)}`
  )

  // THE EXCURSION, measured rather than asserted from the knobs: what the effect
  // was asked for is a metre or so of travel side to side, and `sway` is the
  // peak displacement, which is half of it. Sampling finely enough to catch the
  // peak of the fastest term.
  let peak = 0
  for (let t = 0; t < 600; t += 0.05) {
    currentDrift(t, 1, v)
    peak = Math.max(peak, Math.hypot(v.x, v.z))
  }
  //
  // The bound is sway * sqrt(1 + cross^2) and NOT sway: the across term is
  // perpendicular, so it adds to the along term in quadrature rather than
  // sharing its amplitude. At cross 0.3 that is 4% over, which is the whole
  // difference between a bound that is true and one that reads nicer.
  const bound = CURRENT.sway * Math.sqrt(1 + CURRENT.cross * CURRENT.cross)
  check(
    2 * peak > 1 && 2 * peak < 1.6 && peak <= bound + 1e-9,
    'she travels about a metre and a half side to side, and no further than the two terms in quadrature',
    `${(2 * peak).toFixed(2)} m of travel, peak ${peak.toFixed(3)} against bound ${bound.toFixed(3)}`
  )

  // NOT A METRONOME. One sine has a period you can feel coming; the test is that
  // the field does not repeat over the couple of minutes anyone will float in
  // one place. Comparing the whole displacement, not one axis, because the cross
  // term is what breaks the repeat.
  let worst = 0
  for (let t = 0; t < 120; t += 0.25) {
    currentDrift(t, 1, v)
    const x = v.x
    const z = v.z
    currentDrift(t + CURRENT.slow, 1, v)
    worst = Math.max(worst, Math.hypot(v.x - x, v.z - z))
  }
  check(
    worst > 0.2 * CURRENT.sway,
    'and the two periods do not line up, so it does not repeat on the long swing',
    `${worst.toFixed(2)} m apart one slow period later`
  )

  // IT IS LATERAL. A vertical push fights the submersion test at the waterline:
  // her eye crosses the surface, the murk goes on and off, and the whole effect
  // strobes.
  currentDrift(3.3, 1, v)
  check(v.y === 0, 'and it never pushes her up or down')

  // STRENGTH SCALES IT LINEARLY and zero is genuinely nothing, which is what
  // makes the ease in and out safe: at strength 0 she is exactly where she would
  // have been, so surfacing cannot leave her displaced.
  currentDrift(11.7, 0, v)
  check(v.x === 0 && v.z === 0, 'and at zero strength it is exactly nothing, so surfacing returns her')

  // THE DIFFERENCE, not the drift. This is the one that walks her out of the
  // world: adding currentDrift's answer every frame integrates it, and a term
  // with a non-zero mean over any finite window becomes a slow march. The call
  // site must add the CHANGE since last frame.
  const v2 = fs.readFileSync(new URL('../src/v2/main.js', import.meta.url), 'utf8')
  check(
    /player\.rig\.position\.x \+= swayWant\.x - swayApplied\.x/.test(v2) &&
      /player\.rig\.position\.z \+= swayWant\.z - swayApplied\.z/.test(v2) &&
      /swayApplied\.copy\(swayWant\)/.test(v2),
    'v2 applies the drift as a difference against what it last applied, not as an increment'
  )
  // BEFORE the mover, so the clamp and the ground test see where she actually
  // is. 70 cm added afterwards is enough to put her inside a bank with nothing
  // left in the frame to push her out of it.
  check(
    v2.indexOf('swayApplied.copy(swayWant)') < v2.indexOf('player.update(dt, moveInput)'),
    'and it lands before the mover, so collision and the world clamp see it'
  )
  // And it eases. The push arriving in one frame is a shove, and a shove in a
  // headset is how you make someone ill -- worst at the waterline, where she
  // crosses the boundary over and over.
  check(CURRENT.ease >= 1, 'and it comes and goes over seconds rather than in a frame', `${CURRENT.ease} s`)
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
