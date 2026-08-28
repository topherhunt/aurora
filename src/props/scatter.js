import THREE from '../three-instance.js'
import { mulberry32, clamp01, smoothstep } from '../sim/mathx.js'
import { buildConifer, buildBoulder, buildGrass, buildCabin } from './shapes.js'
import { buildFernBank, fernCardGeometries, bakeFernImpostors } from './fern-bank.js'
import { createPropMaterial } from '../material.js'

// ---------------------------------------------------------------------------
// Scattered props -- a SCALE REFERENCE, not the placement system.
//
// The real thing is DESIGN.md §6 (density fields from the Phase A biome pass,
// path-aware clearing, village exclusion) plus §5's LOD tiering, and it lands at
// build step 5. None of that exists yet and building it now would mean building
// it blind.
//
// What this is for: an empty heightfield gives you no way to judge how big a
// mountain is or how fast you are moving across it. Trees give you one number,
// but only one. A cabin, a boulder you could sit on and a tuft of grass at your
// feet give you four scales an order of magnitude apart, and it is having
// several at once that makes a valley read as a valley rather than as a shape.
//
// It does share the architecture it needs to share (§5): ONE BatchedMesh, ONE
// material, per-instance geometry selection. If that is wrong, better to find
// out on 1,200 props than on 40,000.
//
// Two rules earn their complexity here:
//
//   Density tapers with distance rather than stopping at a cull radius. A hard
//   edge is visible as a moving wall of trees; a taper reads as depth. The far
//   ring also carries a scale fade so the outermost instances dissolve rather
//   than pop, because at 800 m the fog is only 3% and hides nothing.
//
//   At most one kind rebuilds per frame. Grass re-places itself every 10 m of
//   travel, which at fly speed is three times a second, and stacking it in the
//   same frame as a tree pass is a visible hitch for no reason.
//
// Every elevation band below is a fraction of the world's actual relief and has
// to move when TUNING in sim/terrain-height.js does. A treeline of 470 m is not
// a treeline once the peaks top out at 252 m -- it is "trees everywhere", and
// the strongest altitude cue in the scene quietly stops working.
// ---------------------------------------------------------------------------

const KINDS = [
  {
    name: 'tree',
    salt: 0x9e3779b9,
    spacing: 30, // metres between candidate cells
    // Was 820. Rebuild cost goes as (radius / spacing)^2 and SCARP's curvature
    // form needs five field evaluations per surviving candidate where the flat
    // world needed one, which put the worst single update() at 4.1 ms against a
    // 4 ms gate. Spacing is not the lever -- that is density, which was doubled
    // deliberately last round -- so reach pays. 750 m still sits at 97% fog
    // transmittance, so this is not hidden by haze and is a real if small loss
    // of the outermost ring of trees; it buys back about 16% of the rebuild.
    radius: 750,
    density: 0.62, // fraction of cells that hold a candidate at all
    tailDensity: 0.3, // ...falling to this at the cull radius
    falloffFrom: 200,
    max: 960,
    minElev: 25,
    snowRel: true, // maxElev is metres ABOVE the local snow line, not absolute
    maxElev: 67, // treeline. One of the strongest scale cues a mountain has:
    elevFade: 45, // it tells you how high you are without a number.
    //
    // This used to sit at 152 absolute, deliberately just UNDER the snow line so
    // the two read as one boundary. That was wrong, and it is worth saying why:
    // a real treeline is well above the snow line, and conifers standing in snow
    // are the single most recognisable thing a snowy mountain has. Tucking the
    // trees below the snow produced bare white slopes with a hard green edge --
    // two boundaries pretending to be one. The thinning band now runs from
    // line+22 to line+67, straddling the snow ramp (line..line+47) so there is a
    // wide belt of snowy forest and the trees give out somewhere up in the white
    // rather than at the moment it turns white.
    //
    // Relative rather than absolute because that relationship is the whole
    // point, and an absolute 215 only preserved it where the snow line sat at
    // its mean. At the mean this is bit-identical to the old 215. All four
    // numbers are post-SHRINK.
    maxSlopeDeg: 32,
    scale: [0.75, 1.3],
    sink: 0.15,
  },
  {
    name: 'rock',
    salt: 0x85ebca6b,
    spacing: 18,
    radius: 430,
    density: 0.5,
    tailDensity: 0.3,
    falloffFrom: 120,
    max: 960,
    minElev: 24,
    maxElev: 1000, // boulders go all the way up; nothing to fade against
    elevFade: 0,
    maxSlopeDeg: 41, // they sit on ground steeper than she can walk
    scale: [0.55, 2.1],
    sink: 0.05,
  },
  {
    name: 'grass',
    salt: 0xc2b2ae35,
    // Grass trades reach for density, which is the opposite of the other kinds.
    // A tuft is ~0.4 m: past 30 m it is a sub-pixel speck and costs a draw for
    // nothing, but within 30 m it is the only thing giving the ground texture at
    // walking pace. So: small disc, tufts ~2.5 m apart rather than ~8 m. ~500
    // instances of 10 tris is 5k -- nothing against the 800k budget.
    //
    // The cost that matters is not the triangles, it is the rebuild: every
    // candidate cell in the disc pays a heightAt and most survivors pay a
    // slopeAt too, and the count of those cells goes as (radius / spacing)^2.
    // At spacing 1.6 / radius 32 that measured 3.0 ms, a fifth of a 72 Hz frame
    // on DESKTOP -- the headset CPU is slower, so that number is a ceiling to
    // stay well under, not a budget to spend.
    //
    // Doubling the density means dividing spacing by sqrt(2), which would have
    // quadrupled nothing but did take the rebuild to 3.45 ms measured. The
    // radius pays for it instead: at 23 m the disc holds about the same number
    // of candidate cells it did at spacing 1.9 / radius 30, so the density
    // doubles for roughly the cost we were already paying. Reach is the right
    // thing to give up here -- by the file's own reasoning above, a 0.4 m tuft
    // at 30 m is a sub-pixel speck, so the tufts being sacrificed are the ones
    // that were never visible.
    spacing: 1.35,
    rebuildEvery: 10, // decoupled from spacing; see update()
    radius: 23,
    density: 0.95,
    tailDensity: 0.5,
    falloffFrom: 12,
    max: 1600,
    minElev: 25,
    // Grass used to give out at 160 with the thinning starting at 130, and that
    // was a band inherited from a taller world without ever being re-read
    // against this one. The world's MEDIAN elevation is 135 m: the ramp began
    // at the middle of the map and grass was gone by a little above it. Two of
    // the four sample sites sit at 165 and 168 m -- ordinary mid-slope ground,
    // nothing alpine about it -- and rejected 661 and 726 of 917 candidate
    // cells on elevation alone, before slope was even asked. That is the whole
    // of the grass disappearing, and it was not the terrain's fault.
    //
    // 160..200 puts the thinning where the trees' does (170..215) and where the
    // snow ramp does (148..195), which is the honest place for it: grass gives
    // out because it is under snow, not at some independent altitude. Below 160
    // -- which is most of the walkable world -- it is now at full density.
    maxElev: 200,
    elevFade: 40,
    maxSlopeDeg: 27,
    scale: [0.8, 1.4],
    sink: 0.03,
  },
  {
    // The first kind on the real pipeline: generated geometry, the shared atlas
    // material, and three LOD tiers. Everything above it is placeholder art on
    // the old vertexColors batch and will be rebuilt to look like this one.
    name: 'fern',
    atlas: true,
    salt: 0x1b873593,

    // Three mesh tiers at 6 / 4 / 2 segments per frond, swapped at 5 m and 10 m
    // and measured in scripts/probe-fern-bank.mjs: 84 / 56 / 28 average
    // triangles. A single 6-segment tier everywhere out to 25 m would cost 82k
    // triangles against this ladder's 42k, so the tiers pay for themselves twice
    // over. The bands come from the previewer: 4 -> 6 segments is an obvious
    // gain in how smooth a frond reads and 6 -> 8 is close to undetectable, so
    // the finest tier only has to reach as far as a frond's curve is legible.
    //
    // The fourth band, at 26 m, is the impostor card, and on THIS kind it is
    // dead: the disc stops at 26 m and the scale fade has already dissolved
    // everything by 21. It is here because `fern_far` below shares this kind's
    // geometry list, and a shared list means a shared tier count. Ferns past
    // 26 m are that kind's job, not this one's.
    lodBands: [5, 10, 26],

    // Rebuild cost, not triangles, is what bounds fern density. Every candidate
    // cell in the disc pays a hash and most survivors pay heightAndSlopeAt, and
    // the cell count goes as (radius / spacing)^2 -- the same wall grass hit.
    // At 1.4 / 26 that is 1,521 cells against grass's 1,369, so this is grass's
    // cost class and it is deliberately not more.
    //
    // That buys ~0.46 ferns/m^2, not the 2.0/m^2 "lush fernscape" the probe
    // prices. Tightening spacing cannot close that gap -- it is quadratic in
    // rebuild time -- and the honest fix is that ferns grow in PATCHES anyway:
    // scatter a few cluster centres and fill each one, which gives high local
    // density for a fraction of the candidate cells. That is a placement change,
    // not a tuning change, and it is not built yet.
    spacing: 1.4,
    rebuildEvery: 8,
    radius: 26,
    density: 0.9,
    tailDensity: 0.45,
    falloffFrom: 15,
    max: 1400,

    // Understory. Ferns want damp shade low down, and they give out well below
    // the grass line rather than at it -- nothing about a fern says alpine.
    minElev: 25,
    maxElev: 150,
    elevFade: 35,
    maxSlopeDeg: 24,
    scale: [0.75, 1.35],
    sink: 0.02,
  },
  {
    // The same fern, sampled sparsely and reaching much further. This is the
    // kind that actually draws impostor cards.
    //
    // WHY A SECOND KIND RATHER THAN A BIGGER RADIUS. Rebuild cost goes as
    // (2 x radius / spacing)^2, and the near kind's 1.4 m spacing is what buys
    // its density. Holding that spacing out to 80 m would be 19,500 candidate
    // cells against its present 1,521 -- thirteen times the rebuild, for a band
    // where a fern is under 7 pixels tall. So reach and density are separated:
    // one kind is dense and short, one is sparse and long, and they overlap the
    // whole way in rather than meeting at a seam.
    //
    // WHAT THE NUMBERS BELOW COST, measured rather than reasoned about. Rebuild
    // time tracks cells x density and almost nothing else: a cell that survives
    // the density roll goes on to pay heightAndSlopeAt, and out here most are
    // then rejected on elevation or slope -- so the expensive call is what the
    // cell count buys whether or not a fern comes of it. The first cut of this
    // kind was 4.5 / 90, which is 1,513 such calls and timed at 3.8 ms median:
    // the most expensive kind in the world, above the near fern's 3.2 and the
    // tree's 3.5, against check-terrain.mjs's 4 ms per-call gate -- and it was
    // the kind that matters least that was buying it. 5.0 / 80 is 980 calls and
    // ~2.5 ms, which puts it back at the bottom of the table where it belongs.
    //
    // IT IS NOT AS DENSE AS THE NEAR BAND AND CANNOT BE. ~0.02 ferns/m^2 out
    // here against ~0.46 close in. Matching them is not a tuning problem: the
    // 26-80 m ring at near density would be ~8,000 instances against a batch
    // cap of 1,200, so the fix is one card standing for a CLUMP of ferns rather
    // than more instances. That is DESIGN.md §5's clump work and it is not
    // built. What this kind buys today is that the world no longer ends in a
    // hard fern-free ring 26 m out; what it does not buy is a lush distance.
    //
    // Same ladder as the near kind, deliberately. Its sparse ferns inside 26 m
    // stand next to dense ones, so they have to be MESHES there or the player
    // would be looking at flat cards among real plants. Only past 26 m does
    // this kind become the card tier.
    name: 'fern_far',
    atlas: true,
    geometryFrom: 'fern',
    salt: 0x6c8f3d17,
    lodBands: [5, 10, 26],
    spacing: 5.0,
    // 24 m of travel between rebuilds, against the near fern's 8. A kind whose
    // instances are 7 px tall does not need re-placing three times as often as
    // one you are standing in, and update() only rebuilds one kind per frame --
    // so a cheap rebuild schedule is also how this kind stays out of the near
    // fern's way.
    rebuildEvery: 24,
    radius: 80,
    density: 0.9,
    tailDensity: 0.4,
    falloffFrom: 40,
    max: 1200,

    // Identical to the near fern's. These describe where a fern GROWS, and that
    // does not change with how far away it is being drawn from.
    minElev: 25,
    maxElev: 150,
    elevFade: 35,
    maxSlopeDeg: 24,
    scale: [0.75, 1.35],
    sink: 0.02,
  },
  {
    name: 'cabin',
    salt: 0x27d4eb2f,
    spacing: 184,
    radius: 1050,
    density: 0.4,
    tailDensity: 0.75,
    falloffFrom: 500,
    max: 56,
    minElev: 26,
    maxElev: 165,
    elevFade: 35,
    maxSlopeDeg: 9, // people build on flat ground, and a box on a slope floats
    scale: [0.95, 1.12],
    sink: 0.35,
  },
]

// Geometry variants per kind. Index into this by kind name.
function buildVariants(seed) {
  return {
    tree: [
      buildConifer({ height: 13.5, radius: 2.5, tiers: 4, segments: 7, lean: 0.02 }),
      buildConifer({ height: 9.0, radius: 2.1, tiers: 3, segments: 6, lean: -0.035 }),
      buildConifer({ height: 17.0, radius: 2.8, tiers: 5, segments: 7, lean: 0.045 }),
    ],
    // "One metre tall" is the brief, and it is a good one: a boulder is the
    // only prop here whose real-world size a person can check by eye.
    rock: [
      buildBoulder({ height: 1.0, squash: 0.72, jitter: 0.18, seed: seed + 1 }),
      buildBoulder({ height: 1.15, squash: 0.5, jitter: 0.26, seed: seed + 2 }),
      buildBoulder({ height: 0.8, squash: 0.9, jitter: 0.12, seed: seed + 3 }),
    ],
    grass: [
      buildGrass({ blades: 6, height: 0.42, width: 0.06, spread: 0.3, seed: seed + 11 }),
      buildGrass({ blades: 4, height: 0.3, width: 0.05, spread: 0.22, seed: seed + 12 }),
    ],
    cabin: [
      buildCabin({ width: 6.2, depth: 4.6, wallH: 2.6, roofPitch: 1.1, seed: seed + 21 }),
      buildCabin({ width: 4.8, depth: 4.0, wallH: 2.3, roofPitch: 1.25, seed: seed + 22 }),
    ],
  }
}

// How far past a band a prop must travel before it drops to the coarser tier.
//
// Without this an instance sitting exactly on a boundary swaps geometry every
// time the player sways, and a fern flickering between 4 and 6 segments at 5 m
// is far more visible than the detail difference the swap is there to deliver.
// 12% of the band -- 60 cm at the 5 m boundary -- is enough that ordinary head
// motion cannot cross it, and small enough that walking never reveals a fern
// holding the wrong tier.
//
// The asymmetry is deliberate: getting FINER happens at the true boundary, so
// detail always arrives on time and only its departure is delayed.
const LOD_HYSTERESIS = 0.12

/**
 * Which tier index a prop should draw at SQUARED distance `d2`, given the tier
 * it draws now (`cur`, or -1 when it is being placed for the first time).
 *
 * Squared throughout because this runs on every live instance of every tiered
 * kind every frame, and a square root per fern buys nothing -- the bands are
 * constants, so they can be squared once at construction instead.
 *
 * `lodBands` is ascending and indexed from the FINEST tier: bands [5, 10] with
 * three tiers means tier 2 within 5 m, tier 1 out to 10 m, tier 0 beyond. Tier
 * order matches fern-bank.js, which emits coarsest-first.
 */
function tierFor(s, d2, cur) {
  if (s.tierCount === 1) return 0
  // `over` counts how many bands we have crossed outward. A band we are already
  // outside of (over >= overCur) is the one holding us at our current tier, so
  // it is the one that gets the hysteresis margin; crossing inward uses the
  // true boundary. See LOD_HYSTERESIS.
  const overCur = s.tierCount - 1 - cur
  const near = s.bandSq
  const far = s.bandSqOut
  let over = 0
  while (over < near.length) {
    if (d2 > (over >= overCur ? far[over] : near[over])) over++
    else break
  }
  return s.tierCount - 1 - over
}

export class Scatter {
  constructor(scene, terrainHeight, textureArray, { seed = 1337 } = {}) {
    this.th = terrainHeight
    this.seed = seed
    this.scene = scene

    // TWO batches, and the split is temporary by design.
    //
    // `atlas` is the real one: the shared prop material sampling the shared
    // texture array (src/material.js, src/textures.js). Every asset ends up
    // here -- one material, one texture binding, one multi-draw call, with a
    // per-vertex texLayer letting a single mesh wear bark on its trunk and
    // leaves on its canopy.
    //
    // `placeholder` is the Quaternius-era vertexColors batch. Its geometries
    // (props/shapes.js) carry `color` and no UVs at all -- shapes.js:41 deletes
    // the uv attribute outright -- so they cannot enter the atlas material
    // without being rebuilt, and they are all slated for replacement anyway.
    // Migrating them would be porting code that is about to be deleted.
    //
    // So kinds route by `k.atlas`, one kind at a time, and when the last one
    // flips this whole batch and shapes.js go with it. Until then the cost is
    // ONE extra draw call out of CALL_BUDGET's 45.
    const variants = buildVariants(seed)
    const fernBank = buildFernBank({ seed: seed + 31 })
    // The card tier's QUADS. Its pixels are not baked here -- see bakeCards()
    // and the note above fernCardGeometries.
    const fernCards = fernCardGeometries()
    // Tiers are coarsest-first, so a band index maps straight to a tier index,
    // and nothing is coarser than a photograph. `perVariant` is 16 entries
    // pointing at 2 geometries, which keeps every tier the same length -- the
    // reshape below divides by tier count and placement picks a variant by
    // indexing tier 0.
    variants.fern = [...fernCards.perVariant, ...fernBank.tiers.flatMap((t) => t.geometries)]
    this.fernTierCount = fernBank.tiers.length + 1
    this.textureArray = textureArray

    this.material = new THREE.MeshLambertMaterial({ vertexColors: true })
    this.atlasMaterial = createPropMaterial(textureArray)

    // Two kinds can draw the same prop at different densities and reaches --
    // `fern` and `fern_far` do -- and when they do they share ONE copy of the
    // geometry in the arena rather than each uploading their own 121 KB.
    const geoKeyOf = (k) => k.geometryFrom ?? k.name

    const makeBatch = (kinds, material, name) => {
      const geos = [...new Set(kinds.map(geoKeyOf))].flatMap((key) => variants[key])
      const batch = new THREE.BatchedMesh(
        kinds.reduce((n, k) => n + k.max, 0),
        geos.reduce((n, g) => n + g.attributes.position.count, 0),
        geos.reduce((n, g) => n + g.index.count, 0),
        material
      )
      batch.name = name
      batch.frustumCulled = false // per-instance culling does the work
      batch.sortObjects = true // front-to-back opaque ordering (§5)
      scene.add(batch)
      return batch
    }

    const atlasKinds = KINDS.filter((k) => k.atlas)
    const plainKinds = KINDS.filter((k) => !k.atlas)
    this.atlasBatch = makeBatch(atlasKinds, this.atlasMaterial, 'props-atlas')
    this.batch = plainKinds.length ? makeBatch(plainKinds, this.material, 'props') : null

    // Per-kind state. Instances are allocated up front and never move between
    // kinds; placement only rewrites geometry id, matrix, colour and visibility.
    const idsByKey = new Map()
    this.kinds = KINDS.map((k) => {
      const key = geoKeyOf(k)
      const geos = variants[key]
      const batch = k.atlas ? this.atlasBatch : this.batch
      // addGeometry copies into the arena, so a shared key uploads once and the
      // second kind reuses the ids. Both kinds then read the same tier table.
      if (!idsByKey.has(key)) idsByKey.set(key, geos.map((g) => batch.addGeometry(g)))
      const geometryIds = idsByKey.get(key)
      const trisPer = geos.map((g) => g.index.count / 3)

      // A kind with LOD tiers hands us tiers x variants geometries in one flat
      // list, coarsest tier first. Reshape it so `tierIds[t][v]` is a lookup
      // rather than an index calculation at every swap.
      const tierCount = k.lodBands ? k.lodBands.length + 1 : 1
      const perTier = geos.length / tierCount
      const tierIds = []
      const tierTris = []
      for (let t = 0; t < tierCount; t++) {
        tierIds.push(geometryIds.slice(t * perTier, (t + 1) * perTier))
        tierTris.push(trisPer.slice(t * perTier, (t + 1) * perTier))
      }

      // Band thresholds, squared once here so tierFor never takes a sqrt.
      // `bandSqOut` is the same boundary pushed out by the hysteresis margin.
      const bands = k.lodBands ?? []
      const bandSq = Float32Array.from(bands, (b) => b * b)
      const bandSqOut = Float32Array.from(bands, (b) => (b * (1 + LOD_HYSTERESIS)) ** 2)

      const state = {
        cfg: k,
        batch,
        geometryIds,
        trisPer,
        tierIds,
        tierTris,
        tierCount,
        bandSq,
        bandSqOut,
        // Per-instance LOD bookkeeping. Placement writes them, _updateLod reads
        // and rewrites them; both are dense over [0, count).
        variantAt: new Uint16Array(k.max),
        tierAt: new Int8Array(k.max).fill(-1),
        instX: new Float32Array(k.max),
        instZ: new Float32Array(k.max),
        instances: [],
        cellX: null,
        cellZ: null,
        dirty: true,
        dirtySince: 0,
        count: 0,
        tris: 0,
        capped: false,
      }
      for (let i = 0; i < k.max; i++) {
        const id = batch.addInstance(geometryIds[0])
        batch.setVisibleAt(id, false)
        state.instances.push(id)
      }
      return state
    })
    // Disposed only now that every kind has claimed its ids -- a shared list
    // would otherwise be freed by the first kind and read by the second. The
    // Set is because the card tier holds one geometry under sixteen entries.
    for (const geos of Object.values(variants)) for (const g of new Set(geos)) g.dispose()
    this.byName = Object.fromEntries(this.kinds.map((s) => [s.cfg.name, s]))

    this._m = new THREE.Matrix4()
    this._q = new THREE.Quaternion()
    this._up = new THREE.Vector3(0, 1, 0)
    this._p = new THREE.Vector3()
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()

    this.frame = 0
    this.stats = {
      count: 0,
      tris: 0,
      lastBuildMs: 0,
      lastBuildKind: '',
      byKind: {},
      capped: false,
      lodSwaps: 0,
      cardBakeMs: 0, // 0 until bakeCards() has run; see it in the HUD
    }
  }

  // Cheap to call every frame: it only does work when she has crossed into a new
  // cell for some kind, and never rebuilds more than one kind per call.
  /**
   * A predicate the owner sets to carve holes in the scatter: `(x, z, kindName)
   * => true` rejects that candidate. Called with every surviving candidate, so
   * it has to be cheap -- a distance test, not a search.
   *
   * `invalidate()` exists because the scatter only rebuilds when the camera
   * crosses a grid cell, and a village finishing its build is a change to the
   * answer that no amount of standing still will notice.
   */
  setExclusion(fn) {
    this.exclude = fn
    this.invalidate()
  }

  /**
   * Photograph the fern into the two impostor layers its cards already point
   * at. Call ONCE, after `loadImageLayers()` has resolved -- before that the
   * fern has no frond texture and the picture would be of nothing.
   *
   * Two ortho renders at 512^2, two 1 MB readbacks and the downsample, and
   * `readRenderTargetPixels` stalls the pipeline for each -- so this is a
   * deliberate one-off hitch at load rather than anything the frame loop does.
   * It is the whole reason there is no offline bake step: an impostor generated
   * from the mesh cannot disagree with the mesh, and there is nothing to
   * rebuild when the generator changes.
   *
   * Until it runs, the cards draw against an empty layer and are discarded by
   * alphaTest, so distant ferns fade in rather than flashing.
   */
  bakeCards(renderer) {
    const t0 = performance.now()
    const baked = bakeFernImpostors(renderer, this.textureArray)
    this.stats.cardBakeMs = performance.now() - t0
    return baked
  }

  invalidate() {
    for (const s of this.kinds) {
      if (!s.dirty) {
        s.dirty = true
        s.dirtySince = this.frame
      }
    }
  }

  update(camX, camZ) {
    this.frame++

    let due = null
    for (const s of this.kinds) {
      const grid = s.cfg.rebuildEvery ?? s.cfg.spacing
      const cx = Math.round(camX / grid)
      const cz = Math.round(camZ / grid)
      if (cx !== s.cellX || cz !== s.cellZ) {
        s.cellX = cx
        s.cellZ = cz
        if (!s.dirty) {
          s.dirty = true
          s.dirtySince = this.frame
        }
      }
      // Oldest outstanding rebuild first, so a kind that keeps going dirty
      // cannot starve one that went dirty earlier.
      if (s.dirty && (due === null || s.dirtySince < due.dirtySince)) due = s
    }

    // Re-tier before rebuilding, not after: a rebuild places instances with the
    // tier they deserve, and walking them again in the same frame would be pure
    // waste.
    const swapped = this._updateLod(camX, camZ)

    if (due) {
      const grid = due.cfg.rebuildEvery ?? due.cfg.spacing
      const t0 = performance.now()
      this._rebuild(due, due.cellX * grid, due.cellZ * grid)
      due.dirty = false
      this.stats.lastBuildMs = performance.now() - t0
      this.stats.lastBuildKind = due.cfg.name
      this._roll()
    } else if (swapped) {
      this._roll()
    }
  }

  /**
   * Move live instances between LOD tiers. Runs EVERY frame, unlike placement.
   *
   * The two have to be separate. Placement is expensive and only runs when the
   * camera crosses a rebuild cell -- 8 m for ferns -- and it measures distance
   * from the SNAPPED cell centre, which can sit 4 m from where the player
   * actually is. Against a 5 m band that is not an approximation we can live
   * with: the tier a fern deserves changes as she walks, not as she crosses a
   * cell boundary. So placement's tier is a first guess and this corrects it
   * from the true camera position on the very next frame.
   *
   * The work is a squared distance and a compare per live instance, and
   * setGeometryIdAt is called only when the tier actually changed -- which for
   * a walking player is a handful of ferns a frame, not all 1,400.
   *
   * Returns whether anything moved, so `update` knows to re-roll the stats.
   */
  _updateLod(camX, camZ) {
    let swaps = 0
    for (const s of this.kinds) {
      if (s.tierCount === 1) continue
      const { instX, instZ, variantAt, tierAt, tierIds, tierTris, instances } = s
      let tris = 0
      for (let i = 0; i < s.count; i++) {
        const dx = instX[i] - camX
        const dz = instZ[i] - camZ
        const cur = tierAt[i]
        const tier = tierFor(s, dx * dx + dz * dz, cur)
        const variant = variantAt[i]
        if (tier !== cur) {
          tierAt[i] = tier
          s.batch.setGeometryIdAt(instances[i], tierIds[tier][variant])
          swaps++
        }
        tris += tierTris[tier][variant]
      }
      s.tris = tris
    }
    this.stats.lodSwaps = swaps
    return swaps > 0
  }

  _roll() {
    let count = 0
    let tris = 0
    let capped = false
    for (const s of this.kinds) {
      count += s.count
      tris += s.tris
      capped = capped || s.capped
      this.stats.byKind[s.cfg.name] = s.count
    }
    this.stats.count = count
    this.stats.tris = tris
    this.stats.capped = capped
  }

  // cx/cz are the centre of the disc in WORLD metres, already snapped.
  _rebuild(s, cx, cz) {
    const k = s.cfg
    const reach = Math.ceil(k.radius / k.spacing)
    const maxSlopeTan = Math.tan((k.maxSlopeDeg * Math.PI) / 180)
    const r2 = k.radius * k.radius
    const fadeFrom = k.radius * 0.82 // scale fade band, so the edge dissolves
    const scaleSpan = k.scale[1] - k.scale[0]

    let n = 0
    let tris = 0
    let capped = false

    for (let jz = -reach; jz <= reach && !capped; jz++) {
      for (let jx = -reach; jx <= reach; jx++) {
        // Hash the ABSOLUTE cell index, not the loop index, so a prop does not
        // move when she does. The kind salt keeps trees and rocks from landing
        // on the same cells as each other.
        const gx = Math.round(cx / k.spacing) + jx
        const gz = Math.round(cz / k.spacing) + jz
        const rand = mulberry32((this.seed ^ k.salt ^ (gx * 73856093) ^ (gz * 19349663)) >>> 0)

        if (rand() > k.density) continue

        const x = gx * k.spacing + (rand() - 0.5) * k.spacing * 0.9
        const z = gz * k.spacing + (rand() - 0.5) * k.spacing * 0.9

        const dx = x - cx
        const dz = z - cz
        const d2 = dx * dx + dz * dz
        if (d2 > r2) continue
        const d = Math.sqrt(d2)

        // Density taper. Tested before any heightAt, so the far majority of
        // candidates cost one hash and nothing else.
        const near = 1 - smoothstep(k.falloffFrom, k.radius, d)
        if (rand() > k.tailDensity + (1 - k.tailDensity) * near) continue

        // §6: reject candidates inside a village footprint. The predicate is
        // injected rather than imported, because the scatter must not care
        // whether villages exist -- and it is asked AFTER the density taper so
        // a village costs nothing on the 90% of candidates already rejected.
        if (this.exclude && this.exclude(x, z, k.name)) continue

        // Height and slope from one shared stencil -- see heightAndSlopeAt().
        // Asked separately these are 15 field evaluations per candidate and a
        // 9.5 ms rebuild; shared they are 6 and it fits in a frame again.
        const { h, tan: slopeTan } = this.th.heightAndSlopeAt(x, z)
        if (h < k.minElev) continue
        // `snowRel` kinds read maxElev as an offset from the LOCAL snow line
        // rather than as an absolute elevation. The treeline has to follow the
        // snow line or the relationship between them -- a wide belt of conifers
        // standing in snow, see the note on tree.maxElev -- only holds where the
        // line happens to sit at its mean. Now that SNOW.swing moves it +/- 22 m
        // an absolute treeline would give bare white slopes in the snowiest
        // regions and no snowy forest at all in the barest.
        const maxElev = k.snowRel ? this.th.snowLineAt(x, z) + k.maxElev : k.maxElev
        if (k.elevFade > 0 && h > maxElev - k.elevFade) {
          // Thin out through the band instead of cutting a hard line.
          const above = (h - (maxElev - k.elevFade)) / k.elevFade
          if (above >= 1 || rand() < above) continue
        } else if (h > maxElev) {
          continue
        }
        if (slopeTan > maxSlopeTan) continue

        if (n >= k.max) {
          capped = true
          break
        }

        const id = s.instances[n]
        const variant = (rand() * s.tierIds[0].length) | 0
        // LOD state, so _updateLod can re-tier this instance every frame
        // without re-running any of the placement work above.
        s.variantAt[n] = variant
        s.instX[n] = x
        s.instZ[n] = z
        // -1 for `cur`: a fern being placed has no tier to be sticky about, so
        // it lands on the true boundary rather than one margin out.
        const tier = tierFor(s, d2, -1)
        s.tierAt[n] = tier
        s.batch.setGeometryIdAt(id, s.tierIds[tier][variant])

        const fade = 1 - smoothstep(fadeFrom, k.radius, d)
        const scale = (k.scale[0] + rand() * scaleSpan) * fade
        this._p.set(x, h - k.sink * scale, z)
        this._q.setFromAxisAngle(this._up, rand() * Math.PI * 2)
        this._s.set(scale, scale, scale)
        this._m.compose(this._p, this._q, this._s)
        s.batch.setMatrixAt(id, this._m)

        // Slight per-instance tint so a stand does not look cloned.
        const g = 0.86 + rand() * 0.28
        this._c.setRGB(clamp01(g * (0.93 + rand() * 0.14)), clamp01(g), clamp01(g * 0.96))
        s.batch.setColorAt(id, this._c)

        s.batch.setVisibleAt(id, true)
        tris += s.tierTris[tier][variant]
        n++
      }
    }

    for (let i = n; i < k.max; i++) s.batch.setVisibleAt(s.instances[i], false)

    s.count = n
    s.tris = tris
    s.capped = capped
    if (capped) {
      console.warn(`scatter: ${k.name} hit its ${k.max} instance cap -- raise max or lower density`)
    }
  }

  dispose() {
    for (const b of [this.batch, this.atlasBatch]) {
      if (!b) continue
      this.scene.remove(b)
      b.dispose()
    }
    this.material.dispose()
    this.atlasMaterial.dispose()
  }
}
