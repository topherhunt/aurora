// ---------------------------------------------------------------------------
// Grasshoppers: the shipped Tripo pick (public/creatures/meadow-grasshopper.glb,
// tools/creatures/ship.mjs; 281 triangles on a 128 px map) on the grass and
// the forest floor below the snow line. Each TILE-metre tile around her rolls
// its own from its seed (critters.js tileSeed) at DENSITY, and a grasshopper
// is a slot in ONE InstancedMesh: every shown one is one draw call, whatever
// their number. No LOD ladder: past SHOW_M nothing is drawn, and within it a
// 300-triangle body at a few dozen instances is cheaper than a second program.
// The head is +X, like every shipped critter (the roster's faceTurnDeg), and
// the loader puts the feet on y = 0 (critters.js loadCritterGlb).
//
// THE COLOUR IS A TINT. The map is one olive-and-tan grasshopper; each rolls a
// mix of TINT_GREEN and TINT_BROWN and a SHADE, a per-channel multiplier on
// the map in linear RGB carried in instanceColor, so a meadow holds greener
// ones beside browner ones in one draw.
//
// EVERYTHING A GRASSHOPPER DOES IS A PURE FUNCTION OF ITS KEY AND THE ROOM'S
// CLOCK (_notes/creature-sync.md), so two clients standing together watch the
// same grasshopper make the same hop at the same moment and the only thing
// ever sent is a release: the second and the spot a hand let one go at, which
// no client can derive (creature-net.js, mode DROP).
// Its life is cut into segments of GRID_S seconds on its own grid (sim/score.js,
// offset by its key's hash so a meadow does not turn over at once), and every
// segment runs from one POST to the next: a seat within TETHER of home rolled
// from the key and the segment index alone. Between the two posts it SITS,
// then hops a bout laid at plan time -- a string of hops along the line
// between the posts, each landing swung off the line and qualified as the
// roll was (dry, gentle, below the snow) -- then sits out the rest of the
// segment at the far post. A bout no jitter can lay is one straight hop, whose
// landing is the post itself: every segment ends on the next one's post, so a
// client meeting a grasshopper mid-segment plans that segment alone and lands
// on the same poses as one that has watched all along. A grasshopper's pose at
// any second is arithmetic on its plan: nothing is integrated, nothing depends
// on the frame or on where she has walked, and one out of sight costs one plan
// a segment.
//
// AFTER SUNSET EVERY POST IS HOME, read off the room's clock at the segment's
// turn (WorldClock.daynessAt, so a client planning a segment late plans the
// night the same), so each hops back to its own tuft as the sun goes down and
// sits there still until the posts scatter again at dawn. The grids are
// offset, so dawn does not launch the meadow on one frame.
//
// THE HOP IS A KICK, GRAVITY'S RISE AND A HARD DROP. What reads as weight is
// the arc's ENDS and its FALL. It CROUCHES first, the body squashed toward
// the ground over CROUCH_S, the wind-up before the kick. The kick is instant,
// at a launch angle rolled in LAUNCH_DEG, and the apex is what that angle
// gives the rolled distance (dist * tan / 4) up to APEX_MAX, so a short hop is
// a low flick and a long one is lofted -- never a short hop under a tall arc,
// which hangs in the air like a balloon. In the air the horizontal speed bleeds away
// (flightProgress: an exponential ease-out at DRAG_K, so the second half of
// the flight covers less ground than the first) and the height over the
// chord is a parabola up under GRAVITY to its apex and a parabola down under
// FALL_G gravities (flightLift), which puts the apex at RISE_FRAC of the
// flight: the take-off is steep, the top does not hang, and the drop onto the
// grass comes down harder and steeper than it went up. A true parabola's fall
// is as slow as its rise, and at this size that reads as floating; the extra
// pull on the way down is the snap of a body with weight. Then it LANDS: the
// body snaps level and squashes and recovers over LAND_S, the legs taking the
// fall. The body pitches with the path's angle by PITCH_K.
//
// SHE ONLY SEES THEM WITHIN SHOW_M. A slot is written only while it is that
// close to her head, and posed only while its HOME is within SHOW_M + TETHER,
// which is as near as any post of its can bring it -- so which ones are posed
// follows from their homes rather than from where a stale pose left them, and
// two clients pose the same ones. Past that a grasshopper holds where it was,
// mid-hop or seated, nobody can see, and the tiles stay resident out to RADIUS
// so the ground within SHOW_M is always rolled. At 6--10 cm a
// grasshopper at 8 m is a few pixels, so there is no pop to see.
//
// bodies() lists the shown ones for the ambience, which chirps them: by day
// now and then, and at night these ARE the near crickets, over the far bed.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { GRID_S, keyHash, phraseRand } from '../../sim/score.js'
import { DROP, dropWire, snap } from '../creature-net.js'
import { CRITTER_GLB, loadCritterGlb, setCritterAsset, tierTintSplice, tileKey, tileSeed, walkTiles } from './critters.js'
import { taken, TOLERANCE_M } from '../taken.js'

export const TILE = 8
// Within this of her head a grasshopper is stepped and drawn.
export const SHOW_M = 8
// Tiles whose centre lies within this are resident: SHOW_M plus a tile's half diagonal, so every point she can see one at is on a rolled tile.
export const RADIUS = SHOW_M + (TILE * Math.SQRT2) / 2
// Grasshoppers per square metre: one per 16 m2, so a tile rolls four and she sees a dozen.
export const DENSITY = 0.0625
// Below this dayness -- the sun on the horizon, the butterflies' line -- none hops; one in the air lands and sits.
export const NIGHT_DAY = 0.6
export const MAX = 256
// Ground within this of the snow line is too cold to roll on, and ground steeper than this is neither grass nor forest floor.
export const SNOW_MARGIN = 20
export const MAX_SLOPE_DEG = 38
// The length in metres, antennae tips to tail, 8 cm give or take a fifth: the mesh's X extent is scaled to it.
export const LENGTH_M = [0.064, 0.096]
// The tint's two ends, per-channel multipliers on the map in linear RGB, mixed by a roll; and the brightness roll on top.
export const TINT_GREEN = [0.65, 1.2, 0.5]
export const TINT_BROWN = [1.15, 0.9, 0.7]
export const SHADE = [0.85, 1.15]
// Seated between hops, seconds; a hop's distance, metres; and the kick's angle off the ground, degrees, which with the distance sets the apex.
export const REST_S = [1, 6]
export const HOP_M = [0.2, 1.5]
export const LAUNCH_DEG = [45, 65]
// The crouch before the kick and the settle after the landing: each this long, the body squashed to this fraction of its height at the deepest.
export const CROUCH_S = 0.12
export const CROUCH_SQUASH = 0.65
export const LAND_S = 0.18
export const LAND_SQUASH = 0.7
// The flight's shape: the horizontal ease-out's rate (the landing speed is exp(-DRAG_K) of the launch's), and the gravities the body falls under past its apex -- 1 is a true parabola, and the extra is the snap.
export const DRAG_K = 1.2
export const FALL_G = 1.5
export const GRAVITY = 9.81
// The fraction of the flight spent rising: the rise takes gravity's time for the apex and the fall takes that over sqrt(FALL_G).
export const RISE_FRAC = 1 / (1 + 1 / Math.sqrt(FALL_G))
// How far from home a grasshopper ranges before its hops are bent back.
export const TETHER = 4
// The body pitches this much of the path's angle in the air.
export const PITCH_K = 0.6
// The room's key for a grasshopper: its bed's tile and its place in the roll. A rolled grasshopper sends nothing -- its whole life is closed form -- and the one thing that goes on the wire under the `gh` prefix is a release.
export const bedKey = (tx, tz) => `gh:${tx},${tz}`
export const keyOf = (tx, tz, i) => `${bedKey(tx, tz)}:${i}`
// The key of one let go at (x, z) rather than rolled by a tile: the drop point to the centimetre, so a peer told the same point plans the same life.
export const dropKey = (x, z) => `gh@${x.toFixed(2)},${z.toFixed(2)}`
/** The grasshoppers' prefix in the room's creature keys (creature-net.js): a release is all they send. */
export const PREFIX = 'gh'
// No hop rises higher than the longest ordinary one at the steepest kick, which is what bounds a recovery hop straight to a post.
export const APEX_MAX = (HOP_M[1] * Math.tan((LAUNCH_DEG[1] * Math.PI) / 180)) / 4
// Seats tried for a post before home itself stands in; hops in one bout at most; and tries to lay a jittered bout whose every landing qualifies before the hops go straight down the line.
const POST_TRIES = 6
const HOPS_MAX = 6
const LAY_TRIES = 3

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const MAX_SLOPE_TAN = Math.tan((MAX_SLOPE_DEG * Math.PI) / 180)
// A heading `yaw` is the body's +X turned about +Y: (cos yaw, 0, -sin yaw); the angle toward (dx, dz) is atan2(-dz, dx).
const headingTo = (dx, dz) => Math.atan2(-dz, dx)
const _n = new THREE.Vector3()
const _x = new THREE.Vector3()
const _z = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()
const _basis = new THREE.Matrix4()

const DRAG_NORM = 1 - Math.exp(-DRAG_K)
/** The fraction of the hop's ground covered at fraction `s` of its flight: an ease-out, the launch speed bleeding away. */
export const flightProgress = (s) => (1 - Math.exp(-DRAG_K * s)) / DRAG_NORM
/** d flightProgress / ds. */
const flightProgressRate = (s) => (DRAG_K * Math.exp(-DRAG_K * s)) / DRAG_NORM
/** The height over the chord at fraction `s` of the flight, as a fraction of the apex: a half-parabola up over RISE_FRAC of the flight, a steeper half-parabola down over the rest. */
export const flightLift = (s) => {
  const u = s < RISE_FRAC ? (RISE_FRAC - s) / RISE_FRAC : (s - RISE_FRAC) / (1 - RISE_FRAC)
  return 1 - u * u
}
/** d flightLift / ds. */
const flightLiftRate = (s) => (s < RISE_FRAC ? (2 * (RISE_FRAC - s)) / (RISE_FRAC * RISE_FRAC) : (-2 * (s - RISE_FRAC)) / ((1 - RISE_FRAC) * (1 - RISE_FRAC)))

export class Grasshoppers {
  /**
   * @param height  V2Height: heightAt, heightAndSlopeAt, snowLineAt
   * @param water   WaterSurfaces: levelAt
   * @param opts.walk    WalkSurface: heightAt(x, z) -- the field or the stone on it
   * @param opts.clock   the room's WorldClock, for daynessAt(seconds): the night a segment's plan reads. Without one the plan reads the frame's own dayness, which is a gate's world of one client.
   * @param opts.assets  a parsed asset (critters.js shape) for a gate; the world fetches the GLB
   */
  constructor(scene, height, water, { seed = 1, walk, clock = null, assets = null } = {}) {
    if (!height || typeof height.heightAt !== 'function' || typeof height.heightAndSlopeAt !== 'function' || typeof height.snowLineAt !== 'function') {
      throw new Error('Grasshoppers needs a height field with heightAt, heightAndSlopeAt and snowLineAt')
    }
    if (!water || typeof water.levelAt !== 'function') throw new Error('Grasshoppers needs WaterSurfaces, for levelAt')
    if (!walk || typeof walk.heightAt !== 'function') throw new Error('Grasshoppers needs the WalkSurface, for heightAt')
    this.height = height
    this.water = water
    this.walk = walk
    this.clock = clock
    this.seed = seed

    // Dry chitin: Lambert, no glint. The tint rides three's own instanceColor.
    this.material = new THREE.MeshLambertMaterial({ color: 0xffffff })
    this.material.onBeforeCompile = (shader) => tierTintSplice(shader, 0)
    this.material.customProgramCacheKey = () => 'grasshoppers'
    this.mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.material, MAX)
    this.mesh.name = 'v2-grasshoppers'
    this.mesh.count = 0
    // Hidden, not merely empty, until the asset lands: the boot's scene census throws on a visible mesh with no geometry.
    this.mesh.visible = false
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // The tint, through three's own vColor; made here so the program is keyed with it from the first draw.
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3).fill(1), 3)
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    // The layer toggle flips the group, so it cannot unhide the mesh before its asset lands.
    this.batch = new THREE.Group()
    this.batch.name = 'v2-grasshoppers'
    this.batch.add(this.mesh)
    scene.add(this.batch)

    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, tile: null,
        // Its key in the room, its place in the bed's roll (the lured set's name for it, and the registry's) and its grid's offset into GRID_S.
        key: '', index: 0, offset: 0,
        homeX: 0, homeZ: 0, x: 0, y: 0, z: 0, len: 0.08, yaw: 0, pitch: 0,
        // The tint (TINT_GREEN..TINT_BROWN by SHADE), linear RGB.
        r: 1, g: 1, b: 1,
        // The segment planned (_segment), the phrase of it playing -- 'sit' at a spot, 'crouch' at one, 'hop' from one spot to another over `dur` with `apex` over the chord, 'land' at one -- and how far into that phrase the pose is. `squash` is the body's height as a fraction of its own.
        seg: null, phrase: null, elapsed: 0, state: 'sit', squash: 1,
        // The ground's normal where it sits.
        nx: 0, ny: 1, nz: 0,
        // Its matrix, and whether the matrix trails the step.
        m: new Float32Array(16), stale: true,
      })
    }
    this.free = this.slots.slice()
    // The releases owed to the room (pending), and the drop key of every release made here, hers or a peer's, so one heard twice lets one grasshopper go.
    this.outbox = []
    this.drops = new Set()
    // Set while a peer's release is being made here: it is theirs, and is not owed back to the room.
    this.applying = false
    this.tiles = new Map()
    this.head = { x: 0, y: 0, z: 0 }
    // The world second the last update posed them at, so a release the hands make between updates is owed to the room at the right second.
    this.now = 0
    this.dayness = 1
    this.overflow = 0
    this.hops = 0
    this.segments = 0
    this.loaded = false
    // The asset's X extent (setCritterAsset); the instance scale is len / length.
    this.length = 1
    // The shown ones, for bodies(): rebuilt by update().
    this.shown = []

    if (assets) {
      this.setAsset(assets)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  async load() {
    this.setAsset(await loadCritterGlb(CRITTER_GLB.grasshopper))
    return true
  }

  setAsset(asset) {
    const bounds = setCritterAsset(this.mesh, this.material, asset, 'grasshoppers')
    this.length = bounds.halfX * 2
    this.loaded = true
  }

  /** Whether a grasshopper may sit at (x, z): warm, dry, no steeper than grass grows. Returns the field height or null. */
  qualify(x, z) {
    const { h, tan } = this.height.heightAndSlopeAt(x, z)
    if (tan > MAX_SLOPE_TAN) return null
    if (h > this.height.snowLineAt(x, z) - SNOW_MARGIN) return null
    const level = this.water.levelAt(x, z)
    if (level !== null && level > h) return null
    return h
  }

  /** A spot a grasshopper can sit at: (x, z) on the walk surface, the field's slope there as its up, facing `yaw`. */
  _spot(x, z, yaw) {
    const { gx, gz } = this.height.heightAndSlopeAt(x, z)
    _n.set(-gx, 1, -gz).normalize()
    return { x, y: this.walk.heightAt(x, z), z, yaw, nx: _n.x, ny: _n.y, nz: _n.z }
  }

  /** Seat `g` on spot `s`, level and unsquashed. */
  _seat(g, s) {
    g.x = s.x; g.y = s.y; g.z = s.z
    g.yaw = s.yaw
    g.nx = s.nx; g.ny = s.ny; g.nz = s.nz
    g.pitch = 0
    g.squash = 1
  }

  _enter(tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const t = { tx, tz, flock: [] }
    const want = DENSITY * TILE * TILE
    const n = Math.floor(want) + (rand() < want % 1 ? 1 : 0)
    for (let i = 0; i < n; i++) {
      const x = (tx + rand()) * TILE
      const z = (tz + rand()) * TILE
      const len = between(rand, LENGTH_M)
      const yaw = rand() * Math.PI * 2
      const mix = rand()
      const shade = between(rand, SHADE)
      if (this.qualify(x, z) === null) continue
      // One she caught is not rolled again; its home is the key.
      if (taken.has('grasshopper', x, z)) continue
      const g = this.free.pop()
      if (!g) { this.overflow++; continue }
      g.tile = t
      g.key = keyOf(tx, tz, i)
      g.index = i
      g.offset = keyHash(g.key) % GRID_S
      g.homeX = x
      g.homeZ = z
      g.len = len
      g.yaw = yaw
      g.r = (TINT_GREEN[0] + (TINT_BROWN[0] - TINT_GREEN[0]) * mix) * shade
      g.g = (TINT_GREEN[1] + (TINT_BROWN[1] - TINT_GREEN[1]) * mix) * shade
      g.b = (TINT_GREEN[2] + (TINT_BROWN[2] - TINT_GREEN[2]) * mix) * shade
      g.seg = null
      g.phrase = null
      g.state = 'sit'
      g.squash = 1
      g.stale = true
      this._seat(g, this._spot(x, z, yaw))
      t.flock.push(g)
    }
    return t
  }

  _leave(t) {
    for (const g of t.flock) {
      g.tile = null
      this.free.push(g)
    }
    t.flock.length = 0
  }

  /** Rebuild every tile around (cx, cz). Boot, and whenever the ground moves under her. */
  place(cx, cz) {
    for (const t of this.tiles.values()) this._leave(t)
    this.tiles.clear()
    this.overflow = 0
    this.head.x = cx
    this.head.z = cz
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
  }

  /**
   * The shown grasshopper nearest a hand at (x, y, z) whose body -- a ball of
   * its own length -- is within `reach` metres: `{ dist, g, size }` for
   * take(), or null. Only the shown ones, since past SHOW_M a body is not
   * stepped and holds wherever it was. For hands.js.
   */
  pickAt(x, y, z, reach) {
    if (!this.loaded) return null
    let best = null
    let bestD = reach
    for (const g of this.shown) {
      const d = Math.hypot(g.x - x, g.y + g.len * 0.5 - y, g.z - z) - g.len * 0.5
      if (d < bestD) {
        bestD = d
        best = { dist: Math.max(0, d), g, size: g.len }
      }
    }
    return best
  }

  /**
   * Catch the grasshopper of a pickAt() hit: its slot goes back to the pool,
   * its home is recorded so the tile never rolls it again, and what the hand
   * holds is returned as a record for hands.js -- the shared geometry and
   * material, its tint and its scale.
   */
  take(hit) {
    const g = hit.g
    const t = g.tile
    if (!t) throw new Error(`Grasshoppers.take: slot ${g.id} is on no tile`)
    const i = t.flock.indexOf(g)
    if (i < 0) throw new Error(`Grasshoppers.take: slot ${g.id} is not in its tile's flock`)
    taken.add('grasshopper', g.homeX, g.homeZ)
    t.flock.splice(i, 1)
    g.tile = null
    const j = this.shown.indexOf(g)
    if (j >= 0) this.shown.splice(j, 1)
    this.free.push(g)
    const k = g.len / this.length
    return {
      kind: 'grasshopper',
      name: 'grasshopper',
      size: g.len,
      geometry: this.mesh.geometry,
      material: this.material,
      color: [g.r, g.g, g.b],
      scale: [k, k, k],
      stowable: true,
    }
  }

  /**
   * A peer caught the grasshopper whose home is (x, z): take it out of its
   * flock here too, shown or not, and record the home. True when a resident
   * tile has it. For hands-net.js.
   */
  evict(key, x, z) {
    if (key !== 'grasshopper') return false
    for (const t of this.tiles.values()) {
      for (const g of t.flock) {
        if (Math.abs(g.homeX - x) >= TOLERANCE_M || Math.abs(g.homeZ - z) >= TOLERANCE_M) continue
        this.take({ dist: 0, g, size: g.len })
        return true
      }
    }
    return false
  }

  /** The geometry and material a packed grasshopper record is drawn with, or null until the asset lands. For hands.js. */
  dress(slot) {
    if (slot.kind !== 'grasshopper') throw new Error(`Grasshoppers.dress: not a grasshopper, ${slot.kind}`)
    if (!this.loaded) return null
    return { geometry: this.mesh.geometry, material: this.material }
  }

  /**
   * Let a caught grasshopper go at (x, _, z): seated on the ground there, at
   * home there, in the resident tile under it, and hopping from the segment it
   * lands in. False where no tile is resident or a grasshopper could not sit --
   * water, a crag, the cold -- and hands.js drops it as a thing.
   *
   * Its key is the drop point rounded to the centimetre, so two clients told
   * the same release plan it the same and watch it hop the same way. The drop
   * is owed to the room (pending), which is the only way the other client is
   * told of it at all.
   */
  release(rec, x, y, z, head = null, now = this.now) {
    if (rec.kind !== 'grasshopper') throw new Error(`Grasshoppers.release: not a grasshopper, ${rec.kind}`)
    x = snap(x); y = snap(y); z = snap(z)
    const t = this.tiles.get(tileKey(Math.floor(x / TILE), Math.floor(z / TILE)))
    if (!t || this.qualify(x, z) === null) return false
    const g = this.free.pop()
    if (!g) { this.overflow++; return false }
    g.tile = t
    g.key = dropKey(x, z)
    g.index = -1
    g.offset = keyHash(g.key) % GRID_S
    g.homeX = x
    g.homeZ = z
    g.len = rec.size
    g.r = rec.color[0]; g.g = rec.color[1]; g.b = rec.color[2]
    g.seg = null
    g.phrase = null
    g.state = 'sit'
    g.squash = 1
    g.stale = true
    this._seat(g, this._spot(x, z, (keyHash(g.key) % 3600) * (Math.PI / 1800)))
    t.flock.push(g)
    this._owe(g.key, now, x, y, z, g.len, g.r, g.g, g.b)
    return true
  }

  /** A grasshopper let go here goes to the room as one anchor in mode DROP; one heard from the room is only remembered, so it is not sent back. */
  _owe(key, T, x, y, z, len, r, g, b) {
    this.drops.add(key)
    if (this.applying) return
    // Its heading is nobody's business: a released grasshopper faces where its own key says, not where the hand was.
    this.outbox.push([dropWire(PREFIX, key), T, x, y, z, 0, 0, DROP, null, len, r, g, b])
  }

  /** The releases this client owes the room since the last call, moved into `into`. For creature-net.js. */
  pending(into = []) {
    for (const a of this.outbox) into.push(a)
    this.outbox.length = 0
    return into
  }

  /**
   * A grasshopper a peer let go: released here at the spot their hand did, in
   * their grasshopper's own tint, and hopping from the segment it lands in --
   * the same segment on both, since its grid is absolute. A drop already made
   * here -- this client's own, come back on a fresh welcome -- is nothing.
   * Where no tile is resident it is refused, and this client never sees that
   * grasshopper. For creature-net.js.
   */
  apply(anchor, now) {
    const [, T, x, y, z, , , mode, by, len, r, g, b] = anchor
    if (by === null) return
    if (mode !== DROP) throw new Error(`Grasshoppers: no anchor mode ${mode}`)
    if (![T, x, y, z, len, r, g, b].every(Number.isFinite)) throw new Error(`Grasshoppers: a drop short of its numbers: ${JSON.stringify(anchor)}`)
    if (this.drops.has(dropKey(x, z))) return
    this.applying = true
    try {
      this.release({ kind: 'grasshopper', size: len, color: [r, g, b] }, x, y, z, null, T)
    } finally {
      this.applying = false
    }
  }

  /** Whether the sun is down far enough that none hops. */
  get night() {
    return this.dayness < NIGHT_DAY
  }

  get stats() {
    let hopping = 0
    for (const g of this.shown) if (g.state === 'hop') hopping++
    return { alive: MAX - this.free.length, tiles: this.tiles.size, shown: this.shown.length, hopping, hops: this.hops, segments: this.segments, overflow: this.overflow }
  }

  /** The grasshoppers within SHOW_M of her head this frame, each with x, y, z, pushed onto `into`. */
  bodies(into) {
    for (const g of this.shown) into.push(g)
    return into
  }

  // --- the plan ---------------------------------------------------------------

  /** Whether the sun is down at world time `t`: the room's clock where there is one, so every client plans the same night, else the frame's own dayness. */
  _nightAt(t) {
    return (this.clock ? this.clock.daynessAt(t) : this.dayness) < NIGHT_DAY
  }

  /**
   * Where grasshopper `g` sits at the turn of its segment `seg`: a seat within
   * TETHER of home rolled from its key and `seg`, home itself when POST_TRIES
   * find none and all night long, null once home is no ground to sit on. A
   * pure function of the key, the segment and the room's clock, so every
   * client has the same one.
   */
  _post(g, seg) {
    const start = seg * GRID_S + g.offset
    const rand = phraseRand(g.key, seg, 0)
    if (!this._nightAt(start)) {
      for (let k = 0; k < POST_TRIES; k++) {
        const a = rand() * Math.PI * 2
        const r = rand() * TETHER
        const x = g.homeX + Math.cos(a) * r
        const z = g.homeZ - Math.sin(a) * r
        if (this.qualify(x, z) !== null) return this._spot(x, z, rand() * Math.PI * 2)
      }
    }
    return this.qualify(g.homeX, g.homeZ) === null ? null : this._spot(g.homeX, g.homeZ, g.yaw)
  }

  /**
   * The hops of a bout over the landing spots `stops`, as
   * `[crouch, hop, land, sit, crouch, hop, land, ...]` phrases from spot `a`
   * with no sit after the last landing.
   */
  _chain(rand, a, stops) {
    const out = []
    let prev = a
    for (let k = 0; k < stops.length; k++) {
      const spot = stops[k]
      const dist = Math.hypot(spot.x - prev.x, spot.z - prev.z)
      // The apex a kick at the rolled angle reaches over that distance, never higher than the longest ordinary hop's: a recovery hop is a long skim, not a lob. The rise takes gravity's time for it, and the whole flight RISE_FRAC's share more.
      const apex = Math.min(APEX_MAX, (dist * Math.tan((between(rand, LAUNCH_DEG) * Math.PI) / 180)) / 4)
      const T = Math.sqrt((2 * apex) / GRAVITY) / RISE_FRAC
      const yaw = dist < 1e-9 ? prev.yaw : headingTo(spot.x - prev.x, spot.z - prev.z)
      // A landing faces the way it travelled; the last one faces the post's own way, rolled with it.
      if (k < stops.length - 1) spot.yaw = yaw
      out.push({ kind: 'crouch', dur: CROUCH_S, at: prev, yaw })
      out.push({ kind: 'hop', dur: T, from: prev, to: spot, apex, yaw })
      out.push({ kind: 'land', dur: LAND_S, at: spot })
      if (k < stops.length - 1) out.push({ kind: 'sit', dur: between(rand, REST_S), at: spot })
      prev = spot
    }
    return out
  }

  /**
   * The bout from spot `a` to spot `b`: a string of hops along the line
   * between them, each no longer than HOP_M and each landing swung off the
   * line by up to half a hop and qualified as the roll was (dry, gentle, below
   * the snow). When no jitter lays one in LAY_TRIES, the hops go straight down
   * the line, and then in fewer and fewer of them until every landing
   * qualifies -- at worst one hop onto `b`, which is a post and so qualifies
   * by construction. A bout is never refused: the segment after this one
   * starts from `b` whatever happens here.
   */
  _lay(g, rand, a, b) {
    const D = Math.hypot(b.x - a.x, b.z - a.z)
    const ax = (b.x - a.x) / D, az = (b.z - a.z) / D
    const n0 = Math.min(HOPS_MAX, Math.max(1, Math.ceil(D / between(rand, HOP_M))))
    // Spot k of n along the line, swung `side` metres off it; the last is `b` itself, at the post's own heading.
    const along = (k, n, side) => {
      if (k === n) return this._spot(b.x, b.z, b.yaw)
      const x = a.x + ax * (D / n) * k - az * side
      const z = a.z + az * (D / n) * k + ax * side
      return this.qualify(x, z) === null ? null : this._spot(x, z, 0)
    }
    for (let attempt = 0; attempt < LAY_TRIES; attempt++) {
      const stops = []
      // Swung off the line by up to half a hop, so a bout is a scribble and not a ruled march.
      for (let k = 1; k <= n0; k++) stops.push(along(k, n0, (rand() * 2 - 1) * (D / n0) * 0.5))
      if (stops.every((sp) => sp !== null)) return this._chain(rand, a, stops)
    }
    for (let n = n0; n >= 1; n--) {
      const stops = []
      for (let k = 1; k <= n; k++) stops.push(along(k, n, 0))
      if (stops.every((sp) => sp !== null)) return this._chain(rand, a, stops)
    }
    throw new Error(`Grasshoppers: no bout laid for ${g.key}`)
  }

  /** The phrases' start offsets, and the list returned. */
  static _starts(phrases) {
    let t = 0
    for (const ph of phrases) { ph.start = t; t += ph.dur }
    return phrases
  }

  /**
   * Segment `seg` of grasshopper `g`: `{ seg, start, a, b, phrases }`, from its
   * post at the turn to its post at the next -- a sit at `a`, the bout laid
   * between (_lay), and the sit that fills the segment out at `b`. Where the
   * two posts are one, and so all night long, the segment is one sit at `a`.
   * Null once home is no ground to sit on.
   *
   * Every term is rolled from the key and `seg` alone, never from the segment
   * before: a client meeting a grasshopper mid-segment plans that segment by
   * itself and lands on the same poses as one that has watched all along
   * (_notes/creature-sync.md).
   */
  _segment(g, seg) {
    const a = this._post(g, seg)
    const b = this._post(g, seg + 1)
    if (a === null || b === null) return null
    const rand = phraseRand(g.key, seg, 1)
    const one = (at) => ({ seg, start: seg * GRID_S + g.offset, a: at, b: at, phrases: Grasshoppers._starts([{ kind: 'sit', dur: GRID_S, at }]) })
    if (Math.hypot(b.x - a.x, b.z - a.z) < 1e-9) return one(a)
    const hops = this._lay(g, rand, a, b)
    // The crouches, flights and landings are the arc's own lengths -- a hurried flight reads as a hiccup -- so only the sits give.
    let fixed = 0, rests = 0
    for (const ph of hops) (ph.kind === 'sit' ? (rests += ph.dur) : (fixed += ph.dur))
    if (fixed >= GRID_S) return one(a)
    const room = (GRID_S - fixed) * 0.9
    if (rests > room) {
      const k = room / rests
      for (const ph of hops) if (ph.kind === 'sit') ph.dur *= k
      rests = room
    }
    const spare = GRID_S - fixed - rests
    const open = Math.min(between(rand, REST_S), spare)
    const phrases = [{ kind: 'sit', dur: open, at: a }, ...hops, { kind: 'sit', dur: spare - open, at: b }]
    return { seg, start: seg * GRID_S + g.offset, a, b, phrases: Grasshoppers._starts(phrases) }
  }

  /** The phrase of `phrases` playing `e` seconds in, the last one past the end. */
  static _phraseAt(phrases, e) {
    let i = phrases.length - 1
    while (i > 0 && phrases[i].start > e) i--
    return phrases[i]
  }

  /**
   * Grasshopper `g` posed `e` seconds into phrase `ph`: seated, crouching into
   * the kick, on the arc between two seats, or settling from the landing.
   */
  _pose(g, ph, e) {
    if (ph.kind === 'sit') {
      g.state = 'sit'
      this._seat(g, ph.at)
      return
    }
    if (ph.kind === 'crouch') {
      g.state = 'crouch'
      this._seat(g, ph.at)
      g.yaw = ph.yaw
      // Down toward the ground, faster toward the end: the wind-up.
      const u = Math.min(1, e / ph.dur)
      g.squash = 1 - (1 - CROUCH_SQUASH) * u * u
      return
    }
    if (ph.kind === 'land') {
      g.state = 'land'
      this._seat(g, ph.at)
      // Squashed by the fall and back up: a half sine over LAND_S.
      const u = Math.min(1, e / ph.dur)
      g.squash = 1 - (1 - LAND_SQUASH) * Math.sin(u * Math.PI)
      return
    }
    const { from, to } = ph
    const s = Math.min(1, e / ph.dur)
    g.state = 'hop'
    g.squash = 1
    g.yaw = ph.yaw
    const p = flightProgress(s)
    g.x = from.x + (to.x - from.x) * p
    g.z = from.z + (to.z - from.z) * p
    // The chord from take-off to landing, ridden at the flight's progress, and the lift over it.
    g.y = from.y + (to.y - from.y) * p + ph.apex * flightLift(s)
    g.nx = 0; g.ny = 1; g.nz = 0
    const vy = ((to.y - from.y) * flightProgressRate(s) + ph.apex * flightLiftRate(s)) / ph.dur
    const vh = (Math.hypot(to.x - from.x, to.z - from.z) * flightProgressRate(s)) / ph.dur
    g.pitch = Math.atan2(vy, vh) * PITCH_K
  }

  /** Pose `g` at world time `now`, planning the segment it falls in; false once its home is no ground to sit on. */
  _play(g, now) {
    if (g.seg === null || now < g.seg.start || now >= g.seg.start + GRID_S) {
      const seg = this._segment(g, Math.floor((now - g.offset) / GRID_S))
      if (seg === null) return false
      g.seg = seg
      this.segments++
    }
    const e = now - g.seg.start
    const ph = Grasshoppers._phraseAt(g.seg.phrases, e)
    if (ph.kind === 'hop' && g.phrase !== ph) this.hops++
    g.phrase = ph
    g.elapsed = e - ph.start
    this._pose(g, ph, g.elapsed)
    return true
  }

  /** Into _quat: on the ground, the body's up along the ground's normal with the body along its heading laid onto the surface; in the air, the heading and the pitch. */
  _orient(g) {
    if (g.state === 'hop') {
      // Pitch about the body's Z, then the heading: 'YZX' applies X (none) first.
      _quat.setFromEuler(_euler.set(0, g.yaw, g.pitch, 'YZX'))
      return
    }
    _n.set(g.nx, g.ny, g.nz)
    _x.set(Math.cos(g.yaw), 0, -Math.sin(g.yaw))
    _x.addScaledVector(_n, -_x.dot(_n)).normalize()
    _z.crossVectors(_x, _n)
    _quat.setFromRotationMatrix(_basis.makeBasis(_x, _n, _z))
  }

  /**
   * One frame: the tiles follow her head, and every grasshopper within SHOW_M
   * is posed from its plan at world time `now` (the room's clock in seconds)
   * and written. Nothing is integrated, so the frame's length does not enter
   * into it and a client that joined a moment ago draws the same pose as one
   * that has watched all along. `dayness` is the world's day scalar, which
   * under NIGHT_DAY is what stills them where there is no clock to read it off.
   */
  update(hx, hy, hz, now, dayness = 1) {
    if (!Number.isFinite(now)) throw new Error(`Grasshoppers.update: bad world time ${now}`)
    this.now = now
    this.dayness = dayness
    this.head.x = hx
    this.head.y = hy
    this.head.z = hz
    walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
    const mat = this.mesh.instanceMatrix.array
    const tint = this.mesh.instanceColor.array
    const show2 = SHOW_M * SHOW_M
    // A grasshopper's every post and landing is within TETHER of its home, so one whose home is further off than this cannot come within SHOW_M this segment and need not be posed. Which ones are posed is then a fact about their homes, not about where a stale pose left them: two clients show the same ones.
    const plan2 = (SHOW_M + TETHER) * (SHOW_M + TETHER)
    const shown = this.shown
    shown.length = 0
    let n = 0
    for (const t of this.tiles.values()) {
      for (const g of t.flock) {
        const px = g.homeX - hx, pz = g.homeZ - hz
        if (px * px + pz * pz > plan2) continue
        // Home washed out from under it -- a lake risen, the snow come down: it holds where it sits.
        if (!this._play(g, now)) continue
        const dx = g.x - hx, dy = g.y - hy, dz = g.z - hz
        if (dx * dx + dy * dy + dz * dz > show2) continue
        shown.push(g)
        // A seated body's matrix holds; a crouching, flying or landing one moves every frame.
        if (g.stale || g.state !== 'sit') {
          _pos.set(g.x, g.y, g.z)
          this._orient(g)
          const k = g.len / this.length
          _scl.set(k, k * g.squash, k)
          _mat.compose(_pos, _quat, _scl).toArray(g.m)
          g.stale = g.state !== 'sit'
        }
        mat.set(g.m, n * 16)
        tint[n * 3] = g.r; tint[n * 3 + 1] = g.g; tint[n * 3 + 2] = g.b
        n++
      }
    }
    this.mesh.count = n
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.instanceColor.needsUpdate = true
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    this.mesh.geometry.dispose()
    this.material.map?.dispose()
    this.material.dispose()
  }
}
