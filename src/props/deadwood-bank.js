import { buildDeadwood, deadwoodParams, DEADWOOD_NAMES, DEADWOOD_VARIANTS, DEADWOOD_TINT } from './deadwood.js'
import { bakeImpostor, buildImpostorCard, impostorCardExtents } from './impostor.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// The shipping dead-wood bank: every variant at every seed, the two mesh tiers
// of each, and the billboard that stands in for all of them past 20 m.
//
// Same job as mushroom-bank.js and the same shape, and it is worth saying where
// the two differ, because the differences are all consequences of one fact:
// A PIECE OF DEAD WOOD IS LONG AND LIES DOWN.
//
//   ONE PHOTOGRAPH PER ATTITUDE, not per species. A stump and a log share
//   nothing in silhouette and a billboard carries nothing but silhouette; an oak
//   log and a birch log share everything except a bark tile the card is 20 m too
//   far away to resolve. So two layers rather than eighteen. The argument and
//   the one case it costs (birch) are written out at LAYER.IMPOSTOR_DEADWOOD_*.
//
//   THE QUAD IS SCALED TO THE VARIANT'S OWN ASPECT, which is exactly what
//   mushroom-bank refuses to do -- it scales its quads by a single ratio so a
//   shared photograph keeps the aspect it was taken at. That refusal is right
//   for a mushroom, where a stretched cap is a visibly wrong dome, and wrong
//   here: a 3 m log IS a 2 m log stretched along its own axis, because both are
//   the same swept near-cylinder at two lengths. Stretching the photograph does
//   the same thing to the picture that `length` did to the mesh.
//
//   NO SEPARATE CROSS TIER. Trees, ferns and mushrooms all put a crossed pair
//   between the last mesh and the billboard. Dead wood does not, because the
//   user set the bands at 10 / 20 / 100 and there is no room for one: the mesh
//   tiers cover everything inside 20 m, where a crossed pair would still be
//   worse than the 44-triangle T1 it would be replacing.
//
// The bank is built at construction, handed to BatchedMesh.addGeometry() and
// disposed. No offline bake step, exactly as the other three banks.
// ---------------------------------------------------------------------------

/**
 * How many seeds each named variant is rolled at.
 *
 * The named table is combinatorial and deliberately coarse -- length, species,
 * how chewed the end is -- so it says nothing about the bend, the kink, where
 * the bark came off, or where the stubs are, and all of those are seeded. Two
 * rolls per name is 36 slots, and the scatter's own yaw and per-instance scale
 * multiply that out again.
 *
 * Two and not three because a slot is a real cost here in a way it is not for a
 * mushroom: dead wood is 70-odd triangles at T0 against a mushroom's handful, so
 * 36 slots is already more arena than the whole mushroom bank's 90.
 */
export const DEADWOOD_SEEDS = 2

/**
 * The subject each attitude's photograph is taken of, and the layer it lands in.
 *
 * The LONGEST variant of each kind, on purpose. A card is a picture stretched to
 * each variant's own extents, and stretching a picture DOWN loses nothing while
 * stretching it up shows the texels -- so the subject should be the biggest
 * thing the layer stands in for, not the average one.
 */
const CARD_SUBJECTS = {
  snag: { name: 'stump-2m-oak', layer: LAYER.IMPOSTOR_DEADWOOD_SNAG },
  log: { name: 'log-3m-oak-blown', layer: LAYER.IMPOSTOR_DEADWOOD_LOG },
}

/** The seed the two photographs are taken at. Fixed, so a rebuild is the same picture. */
export const DEADWOOD_CARD_SEED = 4177

/**
 * Every variant x seed, in a stable order. An index into this is a variant id,
 * and it is what the scatter stores per instance.
 */
export function deadwoodBankVariants() {
  const out = []
  for (const name of DEADWOOD_NAMES) {
    const v = DEADWOOD_VARIANTS[name]
    for (let i = 0; i < DEADWOOD_SEEDS; i++) {
      out.push({
        name,
        kind: v.p.kind,
        envs: v.envs,
        // One seed per SLOT and not per name: two rolls of the same name that
        // shared a seed would be the same log twice.
        seed: DEADWOOD_CARD_SEED + i * 9173,
        impostorLayer: CARD_SUBJECTS[v.p.kind].layer,
      })
    }
  }
  return out
}

/**
 * The impostor layers, for `createPropMaterial({ billboardLayers })`.
 *
 * Necessary and not sufficient, exactly as treeImpostorLayers and
 * mushroomImpostorLayers are: the shader's second condition is the vertex
 * normal, and only the billboard's is vertical. Dead wood has no second card
 * tier for that to matter to today, but the list has the same meaning.
 */
export function deadwoodImpostorLayers() {
  return [LAYER.IMPOSTOR_DEADWOOD_SNAG, LAYER.IMPOSTOR_DEADWOOD_LOG]
}

/** The horizontal span a card has to cover, and the height. */
function cardExtentsOf(u) {
  return {
    // The LONG horizontal axis. A snag's two are the same to within its lean; a
    // log's are its length and its thickness, and a card showing the thickness
    // would be a picture of a disc.
    width: Math.max(u.measured.width, u.measured.depth),
    height: u.measured.height,
  }
}

/**
 * The photograph's subject, built, plus the framing and the angle to shoot from.
 *
 * The AZIMUTH is the part that is specific to this family. bakeImpostor stands
 * its camera at `(sin a, 0, cos a)` and a log is laid down the +Z axis, so at
 * the default azimuth of 0 the camera is looking straight down the log and
 * photographs a disc. A quarter turn puts it broadside, which is the only view
 * of a fallen log worth keeping.
 */
/**
 * The angle the kind's photograph is taken from, in bakeImpostor's convention.
 *
 * ONE function and not two constants, because a FIXED card has to lie in the
 * plane its own photograph was taken in and a bake angle that drifted away from
 * the quad's angle would show a broadside log edge-on. Both callers below read
 * this, and the gate reads it too.
 */
export function cardAzimuth(kind) {
  return kind === 'log' ? Math.PI / 2 : 0
}

function cardSubject(kind) {
  const { name } = CARD_SUBJECTS[kind]
  const geo = buildDeadwood({ ...deadwoodParams(name, DEADWOOD_CARD_SEED), tier: 0 })
  return { geo, frame: { ...cardExtentsOf(geo.userData.deadwood), azimuth: cardAzimuth(kind) } }
}

function geometryBytes(geo) {
  let n = geo.index ? geo.index.array.byteLength : 0
  for (const name of Object.keys(geo.attributes)) n += geo.attributes[name].array.byteLength
  return n
}

/**
 * Build the whole bank in the shared prop batch's attribute layout.
 *
 * Returns `{ tiers, variants, bytes, triangles }` with `tiers[t].geometries[v]`
 * the geometry for tier `t` and variant id `v`. All three tiers are the same
 * length, so a band index and a variant id are independent lookups.
 *
 * The caller owns the geometries and MUST dispose them once they are in the
 * batch -- BatchedMesh copies the vertex data into its own arena.
 *
 * The CARD tier arrives as quads with no pixels behind them; the photograph
 * needs a live renderer and this runs in a constructor and in node. See
 * bakeDeadwoodImpostors. Until that runs the cards sample an empty layer and
 * alphaTest discards them, so distant dead wood fades in rather than flashing.
 */
export function buildDeadwoodBank({ billboard = true } = {}) {
  const variants = deadwoodBankVariants()
  const t0 = []
  const t1 = []
  const cards = []

  for (const v of variants) {
    const p = deadwoodParams(v.name, v.seed)
    const near = buildDeadwood({ ...p, tier: 0 })
    t0.push(near)
    t1.push(buildDeadwood({ ...p, tier: 1 }))

    // MEASURED off T0 and hung on the variant record, because the scatter needs
    // all three and none of them is derivable from the variant's name: `length`
    // is the SPINE's length and what a bend, a flare and a lie-down made of it
    // is a different number. The scatter seats a log by sampling the ground at
    // its two ends (`long`) and buries the uphill side of a piece by its own
    // half-thickness (`radius`); `height` is what the card is scaled to.
    const m = near.userData.deadwood.measured
    v.long = Math.max(m.width, m.depth)
    v.height = m.height
    v.radius = m.buttDiameter * 0.5

    if (!billboard) continue

    // Sized off THIS variant's own mesh, so the card the player crosses into is
    // the same size and in the same place as the mesh they crossed out of. The
    // mesh is centred on its own footprint (see buildDeadwood) and so is the
    // quad, which is the other half of the same requirement.
    //
    // Through impostorCardExtents, because the photograph does not fill the
    // texture: bakeImpostor frames the subject with MARGIN of empty pixels all
    // round so a stub or a splinter leaning out cannot be sliced off at the
    // edge. The quad has to be the FRUSTUM, margin included, or the picture
    // comes back inset and the log reads a size too small.
    //
    // A SNAG SPINS AND A LOG DOES NOT, and the difference is the same one this
    // whole file is organised around: a stump is very nearly a solid of
    // revolution, so turning its card to the eye every frame shows the same
    // silhouette from every side and costs nothing. A LOG HAS A DIRECTION. Spun,
    // its card holds still against the eye while the mesh underneath it points
    // along a yaw, so the moment the LOD swaps the log appears to snap to a new
    // heading -- and it snaps back the instant the player walks in again. Fixed,
    // the card is carried by the instance's own yaw and the log lies where it
    // lay, which is what the swap has to look like.
    //
    // The plane has to match the angle the photograph was taken at, which is
    // what `azimuth` is doing: the log was shot broadside from +X (see
    // cardSubject), so its quad spans the +Z axis the log is built along. The
    // snag was shot from +Z and takes the default. `upNormal` is the marker
    // material.js reads to decide which of the two it is holding -- see
    // CARD_UP_MARK -- so the two options are one decision written twice.
    const ext = impostorCardExtents(cardExtentsOf(near.userData.deadwood))
    const spun = v.kind !== 'log'
    cards.push(buildImpostorCard(ext.width, ext.height, v.impostorLayer, 1, {
      upNormal: spun,
      azimuth: spun ? 0 : cardAzimuth(v.kind),
    }))
  }

  const tiers = [{ geometries: t0 }, { geometries: t1 }]
  if (billboard) tiers.push({ geometries: cards })

  // Per SLOT for `t.triangles`, because that is what the scatter indexes to
  // price an instance; per DISTINCT geometry for the totals, because that is
  // what the arena holds. Nothing shares a buffer today and the identity set is
  // what keeps the two honest if anything starts to.
  const counted = new Set()
  let bytes = 0
  let triangles = 0
  for (const t of tiers) {
    t.triangles = t.geometries.map((g) => g.index.count / 3)
    for (const g of t.geometries) {
      if (counted.has(g)) continue
      counted.add(g)
      bytes += geometryBytes(g)
      triangles += g.index.count / 3
    }
  }
  return { tiers, variants, bytes, triangles }
}

/**
 * Photograph one snag and one log into the two impostor layers the cards already
 * point at, in place. Call ONCE, and only after loadImageLayers() has landed --
 * dead wood wears the trees' bark PNGs, which arrive over the network, and a
 * bake that ran first would photograph the procedural fallback.
 *
 * TINTED, with the same DEADWOOD_TINT the family's own material wears. A card
 * baked untinted is live bark standing 20 m in front of the player next to dead
 * bark, and the swap distance is fixed, so the step reads as a wall.
 *
 * Two ortho renders and two readbacks, each of which stalls the pipeline: a
 * deliberate one-off hitch at load, not anything the frame loop does.
 */
export function bakeDeadwoodImpostors(renderer, texArray) {
  return Object.entries(CARD_SUBJECTS).map(([kind, { layer }]) => {
    const { geo, frame } = cardSubject(kind)
    const ext = bakeImpostor(renderer, geo, texArray, layer, { ...frame, tint: DEADWOOD_TINT })
    geo.dispose()
    return { kind, layer, ...ext }
  })
}

/** What the bank costs, without building it. The gate and the HUD price it with this. */
export function deadwoodBankTriangles() {
  const bank = buildDeadwoodBank({ billboard: true })
  const out = {
    t0: bank.tiers[0].triangles.reduce((a, b) => a + b, 0),
    t1: bank.tiers[1].triangles.reduce((a, b) => a + b, 0),
    card: bank.tiers[2].triangles.reduce((a, b) => a + b, 0),
    variants: bank.variants.length,
    bytes: bank.bytes,
  }
  for (const t of bank.tiers) for (const g of t.geometries) g.dispose()
  return out
}
