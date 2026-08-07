import { TUNING, SNOW, SHRINK } from './sim/terrain-height.js'
import { LOD, MIN_TRI_DEG, MAX_TRI_DEG, MAX_DEPTH } from './terrain/quadtree.js'
import { SLOT_COUNT } from './terrain/terrain.js'

// ---------------------------------------------------------------------------
// Live terrain tuning panel (desktop previewer only; `T` toggles it).
//
// This exists to close a vocabulary gap rather than to save typing. Describing
// a terrain fault in words -- "the median octave at fifteen metres or so has
// too much amplitude" -- requires knowing which constant that is, and the
// constants are named after what they DO (`ridgeGain`, `jagAmp`) rather than
// after the scale they act at. So every frequency knob here is labelled with
// its real-world wavelength, and every multi-octave layer is labelled with the
// full range it spans. "Backbone ridges, 345 m .. 86 m over 3 octaves" is a
// thing you can point at from inside the world.
//
// The wavelength is 1/(freq * SHRINK), NOT 1/freq: TUNING is expressed in
// pre-SHRINK units (see the header of terrain-height.js) and every number in
// this panel would otherwise be 2x wrong -- silently, and in the one direction
// that still looks plausible.
//
// terrain-height.js's own comments are not consistent about this, so the formula
// here was checked against the field rather than against them. Turning every
// layer off but one, forcing it to a single octave and measuring the mean
// distance between local maxima along a 16 km transect gives 678 m for massif
// (predicted 862), 154 m for ridge (172), 50 m for jag (59) and 38 m for detail
// (45) -- a consistent ~0.85x, which is what a 1D slice through isotropic 2D
// noise gives. The comments that quote 1/f instead ("~345 m backbone", "~1.7 km
// massifs", "a 5 km swell") are stating field units, i.e. twice the scale of the
// world she is standing in.
//
// Three destinations, and they behave differently, which is why knobs carry an
// explicit `src` rather than being looked up by name:
//
//   TUNING / SNOW -- the height field. Mutating them here updates the main
//     thread's TerrainHeight (same module instance, so collision follows
//     immediately) but NOT the workers, which hold
//     their own module instances. Terrain.retune() ships them across and
//     re-streams the world; without that the mesh and the ground she stands on
//     would silently disagree.
//   LOD -- selection only, main thread, no regeneration. A reselect is enough,
//     and it is instant.
//
// Props are NOT re-placed on a retune: scatter.js caches placements per chunk,
// so trees stay where the old height field put them until they stream out.
// That is a known cosmetic artefact of the tool, not of the terrain.
// ---------------------------------------------------------------------------

// A selection larger than this cannot be given slots: terrain's LRU refuses to
// evict anything currently rendering, so once `desired` approaches SLOT_COUNT
// the pool exhausts and _acquire throws. That is the correct behaviour for the
// engine -- it is a broken invariant -- but this panel's whole job is to let
// someone push LOD.triDeg until something gives, and losing the session to an
// exception is a bad way to find the ceiling. So the panel backs the target off
// instead and says so. SLOT_COUNT less the 21 pinned base-layer
// chunks, less a frame's worth of in-flight arrivals (2 workers x 6 deep).
const SELECT_BUDGET = SLOT_COUNT - 21 - 12

const k = (key, min, max, step, desc, opts = {}) => ({
  key,
  min,
  max,
  step,
  desc,
  ...opts,
})

// `src`: 'T' TUNING, 'S' SNOW, 'L' LOD (selection-only).
// `freq`: annotate with wavelength. `oct`: the companion octave-count key, so
// the annotation can report the whole span the layer covers. `amp`: the value is
// pre-SHRINK metres, so annotate with what it is worth in the world.
//
// Every knob carries a `desc`. Names like `valleyRelief` say what a constant is
// called, not what turning it does, and half of these layers are GATED by
// another knob in the same group -- an amplitude multiplied by a mask that is
// zero where you happen to be standing looks exactly like a broken slider. Where
// a knob depends on another, the description says which one, because that
// dependency is the whole reason the panel was confusing.
// TWELVE KNOBS, and the cut from seventy-five is the point rather than a
// side effect. What was here before was every constant in TUNING exposed as a
// slider, which is not a control panel -- it is the source file with a mouse
// interface. It failed for three reasons worth recording, because the same
// failure is easy to rebuild:
//
//   ABOUT A THIRD WERE GATE ENDPOINTS. `cliffGateLo`, `creaseHi`, `massifLo`
//   and their two dozen siblings are smoothstep edges on internal noise. Nobody
//   can predict what moving one by 0.05 does, because the answer depends on the
//   distribution of a field you cannot see. They were solved once, against
//   measurements recorded in terrain-height.js, and the right place for a solved
//   constant is the source, not a slider.
//
//   MOST OF THE REST WERE GATED TO INVISIBILITY. A slider that moves an
//   amplitude which is then multiplied by three masks does nothing wherever any
//   mask is shut -- which, for the cliff layer as shipped, was 96% of the world.
//   Dragging it and seeing no change is indistinguishable from a broken control,
//   and that is most of what "they don't do the thing that they say they do"
//   was reporting. It was accurate.
//
//   AND THE ONE THING THAT ACTUALLY DECIDED THE LOOK WAS NOT ON THE PANEL AT
//   ALL. Whether a world reads as a coherent range or as noise is set by the
//   SLOPE RATIO between tiers -- amplitude divided by wavelength, layer against
//   layer. Six independent amplitudes in metres and six independent frequencies
//   is twelve sliders that jointly control one thing nobody can see, and it is
//   perfectly possible -- it is what shipped -- to have three layers running at
//   the same steepness at different scales, which is exactly what "jumbled
//   chaos" looks like. Run `node scripts/ladder.mjs` for that number directly.
//
// So the rule for what earns a slider: it must change the CHARACTER of the world
// visibly within a couple of seconds of dragging, from wherever you happen to be
// standing. Everything else lives in terrain-height.js with its reasoning next
// to it. If one of those is genuinely wrong, the fix is an edit and an argument,
// not a slider that hides the question.
const GROUPS = [
  {
    title: 'The mountains',
    src: 'T',
    note: 'The five that decide the silhouette. Check them with `node scripts/skyline-png.mjs`, which draws the horizon as she would see it -- a top-down render cannot show whether summits differ in height, only whether they exist.',
    knobs: [
      k('massifRelief', 60, 800, 10,
        'How tall the mountains are. This is the master vertical scale: every other height in the world is meant to sit below it, so raising this alone makes the world grander, and raising the rock knobs to match is what makes it chaotic.',
        { amp: true }),
      k('massifFreq', 0.0002, 0.0016, 0.00002,
        'How far apart the mountains are. Lower = fewer, broader massifs with longer flanks between them. Steepness is relief DIVIDED by this, so halving it at fixed relief halves every mountainside angle -- this is the knob to reach for if the world feels like a maze of walls.',
        { freq: true, oct: 'massifOctaves' }),
      k('peakContrast', 0, 1.2, 0.02,
        'How much taller the tallest massifs are than the shortest. 0 makes every summit the same height, which reads as a hedge along the horizon rather than as peaks; 0.6 makes the big ones about three times the small ones. This is the single knob for "some looming way larger than others".'),
      k('massifSharp', 0.6, 2.5, 0.05,
        'Spire versus dome. Above 1 the summit stays put and the approach to it steepens, so the peak comes to a point; below 1 it rounds off into a whaleback. Cheap pointiness -- it acts only near the top and leaves the flanks and valleys alone.'),
      k('mountainRelief', 0, 260, 5,
        'Height of the sub-peaks riding on the massif flanks -- what makes a massif read as a mountain rather than a hill. Keep it well under a third of massifRelief: when the two approach each other no single scale wins and the range dissolves into lumps.',
        { amp: true }),
    ],
  },
  {
    title: 'Rock and smooth ground',
    src: 'T',
    note: 'ONE RULE decides all of this, and it is worth knowing before you drag anything: rockiness follows landform POSITION, not height. Convex ground -- spurs, ribs, crests, outcrops -- sheds its debris and stands as bare jagged rock; concave ground -- hollows, saddles, gullies, valley floors -- collects it and fills smooth. Same rule on a low knoll as on a summit, which is why low hills are rocky now and high saddles are not. The smooth hollows are also the paths: they run unbroken from the valley floor to the ridge, so the routes up a mountain are what this rule leaves behind rather than anything placed.',
    knobs: [
      k('exposureBias', -0.35, 0.35, 0.01,
        'HOW MUCH OF THE WORLD IS ROCK. Slides the crest/hollow boundary: negative leaves only the sharpest spurs bare and everything else grassy, positive strips the whole world back to rock. The first knob to reach for -- it changes the FRACTION of ground that is rough rather than how violent the rough part is, which is the difference that decides whether she can get anywhere.'),
      k('exposureBand', 0.05, 0.9, 0.01,
        'How abruptly rock gives way to smooth ground. Small draws a hard crag line partway up a hillside -- meadow below, rock above; large blends the two over a whole flank so the ground breaks up gradually as it rises.'),
      k('lowlandRock', 0, 1, 0.02,
        'How rocky low ground is, at equal exposure. 1 makes a knoll in a meadow as savage as a summit; 0 restores the old behaviour where rock was a function of altitude and every low hill came out as smooth clay. Around 0.45 gives low outcrops the same shape at a gentler angle.'),
      k('jagAmp', 0, 120, 2,
        'Depth of the notches and knobs along a crest, 60 m down to 7 m -- the macro jag that gives a summit its silhouette. Gated by exposure, so it lands on crests and does nothing in the hollows between them however high you take it.',
        { amp: true }),
      k('detailRock', 0, 30, 0.5,
        'Height of the juts at the 1-10 m scale, on fully exposed rock -- the scale at which ground stops reading as shape and starts reading as rock. This is what you are standing next to. Its counterpart on soil is fixed low; only the rock end is worth a slider.',
        { amp: true }),
      k('creaseAmp', 0, 24, 0.5,
        'Ribs and gully edges: slope BREAKS rather than more bumps. This is the one layer that adds hard kinks instead of smooth blobs, which is what stops exposed rock reading as crumpled cloth. Small numbers do a lot; past about 12 a hillside turns to corduroy.',
        { amp: true }),
      k('cliffAmp', 0, 90, 2,
        'Height of the step where the cliff mosaic breaks. Rare on purpose -- about 2% of the world, on the most exposed crests only. It was 60 and drew a carpet of squiggles over every summit; if that look returns, this is the knob.',
        { amp: true }),
    ],
  },
  {
    title: 'Lowlands and snow',
    src: 'T',
    knobs: [
      k('valleyLo', 0.2, 0.95, 0.01,
        'How much of the world is low heath. The regional swell is floored below this value, so raising it drops more ground to near sea level WITHOUT lowering the peaks -- which is the whole reason it is a floor rather than a shift.'),
      k('valleyRelief', 0, 700, 10,
        'How high the high country sits above the heath, before any mountain is added. A slow 2.6 km swell, so this is what separates highland from lowland rather than anything you can see the edge of.',
        { amp: true }),
    ],
  },
  {
    title: 'Snow line',
    src: 'S',
    note: 'COLOUR ONLY -- these do not move the ground, so the "here" readout is blank for them.',
    knobs: [
      k('base', 0, 300, 1,
        'Mean snow-line elevation in world metres. Ground above it is white, below it is not. Compare against the elevation shown in the HUD.'),
      k('band', 5, 150, 1,
        'Vertical distance over which bare ground fades to full snow. Small is a crisp line; large is a long dirty-snow gradient.'),
      k('swing', 0, 80, 1,
        'How far the line wanders regionally, so it is not a perfect contour across the whole world.'),
    ],
  },
]

// Separate from GROUPS because nothing here regenerates terrain -- these only
// change which nodes get selected, so they apply on the next frame with no
// re-stream at all. That difference is worth keeping visible in the code.
const LOD_GROUP = {
  title: 'LOD -- where the triangles go',
  src: 'L',
  note: 'One knob, in the units your eye works in. The rule is: keep splitting until no triangle on screen looks bigger than this many degrees -- so a triangle underfoot and a triangle on the horizon end up the same size in your view, which is the whole point. This replaced a splitK plus five elevation-bias rows that privileged high ground and produced the opposite: whole near quadrants blockier than the distant ones behind them. quadtree.js has the measurements, including why a cleverer rule that measures each chunk\'s actual geometric error was built, priced and then thrown away. Watch `slots` below: the pool is a hard ceiling and the panel will back this off if the selection overruns.',
  knobs: [
    k('triDeg', MIN_TRI_DEG, MAX_TRI_DEG, 0.05,
      'The largest a triangle may ever look -- also on [ and ]. 1.0 deg is roughly a thumbnail at arm\'s length. Smaller is finer and costs triangles as 1/deg^2, so halving it is four times the terrain; below about 1.1 the selection stops fitting in the slot pool.',
      { label: 'max triangle (degrees)' }),
  ],
}

const ALL_GROUPS = [LOD_GROUP, ...GROUPS]

function metres(m) {
  return m >= 1000
    ? `${(m / 1000).toFixed(2)} km`
    : m >= 10
      ? `${m.toFixed(0)} m`
      : `${m.toFixed(1)} m`
}

// Everything in TUNING is pre-SHRINK; the world is the field sampled at
// SHRINK x and divided by SHRINK. See the file header. This applies to the
// AMPLITUDES as well as the frequencies: `valleyRelief: 300` is 150 m of world.
const wavelength = (freq) => 1 / (freq * SHRINK)

// Where the sensitivity probe samples, in metres from the player: the point she
// is standing on, then rings at arm's length, at hillside scale, and at the far
// edge of what is legible. 13 points, because the probe costs 2 heightAt calls
// per point per knob and heightAt is the most expensive function in the project.
const PROBE_RINGS = [
  [0, 1],
  [40, 4],
  [150, 4],
  [500, 4],
]
// Re-probe once the player has walked far enough that the answer could differ.
const PROBE_MOVE = 200

const CSS = `
#tuner {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 20; width: 380px;
  overflow-y: auto; color: #cfe3ff; background: rgba(8,14,26,.94);
  border-left: 1px solid #2b4a72; font: 11px/1.45 monospace; padding: 8px 10px 40px;
}
#tuner h2 { font-size: 12px; color: #7fd1ff; margin: 0 0 6px; }
#tuner .t-note { color: #7f95b4; margin: 0 0 8px; }
#tuner .t-live { background: #0e1728; border: 1px solid #2b4a72; border-radius: 4px;
  padding: 6px 8px; margin-bottom: 8px; white-space: pre; }
#tuner .t-warn { color: #ff9a7a; }
#tuner .t-ok { color: #9dffb0; }
#tuner details { border-top: 1px solid #1e3253; padding: 4px 0; }
#tuner summary { cursor: pointer; color: #7fd1ff; padding: 3px 0; user-select: none; }
#tuner summary.t-dirty::after { content: ' *'; color: #ff9a7a; }
#tuner .t-knob { display: grid; grid-template-columns: 1fr 72px; gap: 4px 6px;
  align-items: center; margin: 5px 0 7px; }
#tuner .t-label { grid-column: 1 / 3; color: #cfe3ff; }
#tuner .t-desc { grid-column: 1 / 3; color: #7f95b4; margin: 1px 0 3px; }
#tuner .t-scale { color: #7f95b4; }
#tuner .t-here { color: #9dffb0; float: right; }
#tuner .t-dead { color: #ff9a7a; float: right; }
#tuner input[type=range] { width: 100%; accent-color: #7fd1ff; }
#tuner input[type=number] { width: 100%; background: #0e1728; color: #cfe3ff;
  border: 1px solid #2b4a72; border-radius: 3px; font: 11px monospace; padding: 2px 3px; }
#tuner .t-row { display: flex; gap: 6px; margin-bottom: 8px; }
#tuner button { flex: 1; background: #17304f; color: #cfe3ff; border: 1px solid #2b4a72;
  border-radius: 4px; font: 11px monospace; padding: 5px; cursor: pointer; }
#tuner button:hover { background: #1f4570; }
#tuner textarea { width: 100%; height: 110px; background: #0e1728; color: #9dffb0;
  border: 1px solid #2b4a72; border-radius: 3px; font: 10px monospace; margin-bottom: 8px; }
`

export class Tuner {
  // `height` is the MAIN THREAD's TerrainHeight -- the same instance the player
  // collides against, and the same module instance this panel mutates, so the
  // sensitivity probe measures the ground she is actually standing on.
  constructor(terrain, height) {
    this.terrain = terrain
    this.height = height
    this.probeAt = null // {x, z} the last probe was taken at
    this.visible = false
    // Retuning re-streams the whole world, so it must not fire on every tick of
    // a dragged slider. The number readout and the label update live; only the
    // regeneration waits.
    this.pending = false
    this.timer = 0
    this.message = ''
    this.knobs = [] // {knob, group, input, range, labelEl, defaultValue}

    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)

    this.el = document.createElement('div')
    this.el.id = 'tuner'
    this.el.style.display = 'none'
    document.body.appendChild(this.el)

    this.el.appendChild(this._header())
    this.live = document.createElement('div')
    this.live.className = 't-live'
    this.el.appendChild(this.live)
    this.el.appendChild(this._buttons())
    this.out = document.createElement('textarea')
    this.out.readOnly = true
    this.out.style.display = 'none'
    this.el.appendChild(this.out)

    for (const g of ALL_GROUPS) this.el.appendChild(this._group(g))
  }

  _header() {
    const h = document.createElement('div')
    const t = document.createElement('h2')
    t.textContent = 'TERRAIN TUNER (T to close)'
    const n = document.createElement('p')
    n.className = 't-note'
    n.textContent =
      'Wavelengths and heights are real world metres. Every knob shows what nudging it is worth WHERE YOU ARE STANDING -- "no effect here" means the layer is gated off on this ground, not that the slider is broken; walk somewhere else or open the gate named in the description. Height changes re-stream every chunk (~1 s); LOD changes apply on the next frame. Nothing here is saved -- reload restores the file values, so copy anything worth keeping.'
    h.append(t, n)
    return h
  }

  _buttons() {
    const row = document.createElement('div')
    row.className = 't-row'

    const copy = document.createElement('button')
    copy.textContent = 'copy changed values'
    copy.onclick = () => this._copy()

    const reset = document.createElement('button')
    reset.textContent = 'reset all'
    reset.onclick = () => this._resetAll()

    row.append(copy, reset)
    return row
  }

  _group(g) {
    const d = document.createElement('details')
    const s = document.createElement('summary')
    s.textContent = g.title
    d.appendChild(s)
    g._summary = s
    // LOD open by default: it is the one section whose effect is visible without
    // knowing which constant you are looking for.
    if (g.src === 'L') d.open = true

    if (g.note) {
      const n = document.createElement('p')
      n.className = 't-note'
      n.textContent = g.note
      d.appendChild(n)
    }

    for (const knob of g.knobs) d.appendChild(this._knob(g, knob))
    return d
  }

  _knob(g, knob) {
    const wrap = document.createElement('div')
    wrap.className = 't-knob'

    const label = document.createElement('div')
    label.className = 't-label'
    wrap.appendChild(label)

    const desc = document.createElement('div')
    desc.className = 't-desc'
    desc.textContent = knob.desc
    wrap.appendChild(desc)

    const range = document.createElement('input')
    range.type = 'range'
    range.min = knob.min
    range.max = knob.max
    range.step = knob.step

    const num = document.createElement('input')
    num.type = 'number'
    num.step = knob.step

    wrap.append(range, num)

    const rec = { knob, group: g, range, num, label, def: this._read(g, knob) }
    this.knobs.push(rec)

    // The number box is deliberately NOT clamped to the slider range. The slider
    // range is a guess at what is useful; a value outside it is how you find out
    // the guess was wrong. The slider just pins to its end in that case.
    const onInput = (v) => {
      if (!Number.isFinite(v)) return // mid-edit ("-", "0.") -- wait for a real number
      this._write(g, knob, v)
      this._sync(rec)
      this._schedule(g)
    }
    range.oninput = () => onInput(parseFloat(range.value))
    num.oninput = () => onInput(parseFloat(num.value))

    this._sync(rec)
    return wrap
  }

  _read(g, knob) {
    if (g.src === 'T') return TUNING[knob.key]
    if (g.src === 'S') return SNOW[knob.key]
    return LOD[knob.key]
  }

  _write(g, knob, v) {
    if (g.src === 'T') TUNING[knob.key] = v
    else if (g.src === 'S') SNOW[knob.key] = v
    else LOD[knob.key] = v
  }

  // Push the model value back into both widgets and rewrite the label. Called
  // on every edit and on reset, so the two inputs can never drift apart.
  _sync(rec) {
    const { knob, group } = rec
    const v = this._read(group, knob)
    if (document.activeElement !== rec.num) rec.num.value = v
    rec.range.value = v
    rec.label.textContent = knob.label ?? knob.key

    if (knob.amp) {
      const w = document.createElement('span')
      w.className = 't-scale'
      w.textContent = `  --  ${v < 0 ? '-' : ''}${metres(Math.abs(v) / SHRINK)} in world`
      rec.label.appendChild(w)
    }

    if (knob.freq) {
      // Ridged layers take |noise|, which folds the field and halves the spacing
      // of what you actually see. Measured on a transect: creaseFreq's 38 m base
      // produces peaks 20 m apart.
      const w = wavelength(v) / (knob.ridged ? 2 : 1)
      const oct = knob.octFixed ?? (knob.oct ? this._read(group, { key: knob.oct }) : 1)
      const span =
        oct > 1
          ? `${metres(w)} .. ${metres(w / 2 ** (oct - 1))} over ${oct} oct`
          : knob.cell
            ? `${metres(w)} cells`
            : metres(w)
      const scale = document.createElement('span')
      scale.className = 't-scale'
      scale.textContent = `  --  ${span}`
      rec.label.appendChild(scale)
    }

    // What this knob is worth where she is standing. A layer whose gate is shut
    // on this ground reads as dead, which is the difference between "this slider
    // is broken" and "this slider is being multiplied by zero right here" -- the
    // one distinction the panel could not previously make. Appended last so it
    // floats right of everything else on the label line.
    if (rec.probe !== undefined) {
      const dead = rec.probe < 0.05
      const here = document.createElement('span')
      here.className = dead ? 't-dead' : 't-here'
      here.textContent = dead ? 'no effect here' : `+/-${metres(rec.probe)} here`
      rec.label.appendChild(here)
    }

    if (v !== rec.def) group._summary.classList.add('t-dirty')
  }

  // A frequency change moves the wavelength printed on its own octave-count
  // sibling and vice versa, so relabel the whole panel rather than tracking
  // which knobs are related to which.
  _relabel() {
    for (const g of ALL_GROUPS) g._summary.classList.remove('t-dirty')
    for (const rec of this.knobs) this._sync(rec)
  }

  // Sensitivity probe: nudge each knob a little in BOTH directions, re-evaluate
  // the height field around the player, and report the larger of the two mean
  // absolute changes.
  //
  // Both directions matters and is not symmetry for its own sake. valleyRelief
  // and valleyLo are both dead upward on floored ground -- raising the floor
  // when you are already under it changes nothing -- but LOWERING valleyLo is
  // exactly the move that brings that ground back to life. A one-sided probe
  // would report the two knobs identically and point at neither.
  //
  // The nudge is relative to the current value where there is one, so a knob is
  // measured at the scale it is actually set to rather than at the scale of a
  // slider range this file guessed at.
  _probe(x, z) {
    if (!this.height) return
    const pts = []
    for (const [r, n] of PROBE_RINGS)
      for (let i = 0; i < n; i++) {
        const a = ((i + 0.5) / n) * Math.PI * 2
        pts.push(x + Math.cos(a) * r, z + Math.sin(a) * r)
      }
    const h0 = []
    for (let i = 0; i < pts.length; i += 2) h0.push(this.height.heightAt(pts[i], pts[i + 1]))

    const drift = () => {
      let sum = 0
      for (let i = 0; i < h0.length; i++)
        sum += Math.abs(this.height.heightAt(pts[i * 2], pts[i * 2 + 1]) - h0[i])
      return sum / h0.length
    }

    for (const rec of this.knobs) {
      // LOD knobs pick which nodes get triangles and SNOW knobs pick a colour.
      // Neither moves the surface, so a height probe would libel both as dead.
      if (rec.group.src !== 'T') {
        rec.probe = undefined
        continue
      }
      const v = this._read(rec.group, rec.knob)
      const d = Math.max(rec.knob.step, v !== 0 ? Math.abs(v) * 0.15 : (rec.knob.max - rec.knob.min) * 0.05)
      this._write(rec.group, rec.knob, v + d)
      const up = drift()
      this._write(rec.group, rec.knob, v - d)
      const down = drift()
      this._write(rec.group, rec.knob, v)
      rec.probe = Math.max(up, down)
    }
    this.probeAt = { x, z }
    this._relabel()
  }

  _schedule(g) {
    this._relabel()
    if (g.src === 'L') {
      // Selection-only: no regeneration, so there is nothing to debounce.
      this.terrain.invalidate()
      return
    }
    this.pending = true
    this.timer = performance.now() + 250
  }

  _resetAll() {
    for (const rec of this.knobs) this._write(rec.group, rec.knob, rec.def)
    for (const g of ALL_GROUPS) g._summary.classList.remove('t-dirty')
    this._relabel()
    this.terrain.invalidate()
    this._apply()
    this.message = 'reset to file values'
  }

  _apply() {
    const tuning = {}
    const snow = {}
    for (const rec of this.knobs) {
      if (rec.group.src === 'T') tuning[rec.knob.key] = TUNING[rec.knob.key]
      if (rec.group.src === 'S') snow[rec.knob.key] = SNOW[rec.knob.key]
    }
    // Everything is sent, not just the changed keys: the workers are stateful,
    // and after several rounds of edits "what has changed since the last send"
    // is a bookkeeping problem with a silent failure mode. A full table is ~90
    // numbers, once per quarter second at most.
    this.terrain.retune({ tuning, snow })
    this.pending = false
    this.probeAt = null // every knob's sensitivity is measured against the new field
  }

  // Only what moved, and labelled with the object it lives in -- the point is to
  // be pasteable back into the source, and three of these tables are in two
  // different files.
  _copy() {
    const bucket = { T: {}, S: {}, L: {} }
    for (const rec of this.knobs) {
      const v = this._read(rec.group, rec.knob)
      if (v !== rec.def) bucket[rec.group.src][rec.knob.key] = v
    }
    const lines = []
    const dump = (name, o) => {
      const keys = Object.keys(o)
      if (keys.length) lines.push(`${name}:`, ...keys.map((key) => `  ${key}: ${o[key]},`))
    }
    dump('TUNING (terrain-height.js)', bucket.T)
    dump('SNOW (terrain-height.js)', bucket.S)
    dump('LOD (quadtree.js LOD)', bucket.L)
    const text = lines.length ? lines.join('\n') : '(nothing changed from the file values)'

    this.out.style.display = 'block'
    this.out.value = text
    this.out.select()
    // Clipboard access is permission-gated and fails outright on a non-secure
    // origin, so the textarea is the real answer and the clipboard write is the
    // convenience. Reporting the failure matters -- silently not copying looks
    // identical to copying.
    navigator.clipboard?.writeText(text).then(
      () => (this.message = 'copied to clipboard'),
      (e) => (this.message = `clipboard refused (${e.name}) -- text is selected above`)
    )
  }

  toggle() {
    this.visible = !this.visible
    this.el.style.display = this.visible ? 'block' : 'none'
    this.probeAt = null // re-measure on open: she has moved since last time
  }

  // Called every frame from the main loop, with the player's head position --
  // the probe is a question about the ground she is standing on, so it needs to
  // know where that is.
  update(pos) {
    if (this.pending && performance.now() >= this.timer) this._apply()

    // Re-probe when the panel opens, after a retune (every sensitivity may have
    // changed), and once she has walked far enough for the answer to differ.
    // Never per frame: 75 knobs x 13 points x 2 directions is ~1950 heightAt
    // calls, measured at 5 ms -- a third of a 72 Hz frame, fine as an event and
    // not fine every frame.
    if (this.visible && pos && this.height) {
      const p = this.probeAt
      if (!p || Math.hypot(pos.x - p.x, pos.z - p.z) > PROBE_MOVE) this._probe(pos.x, pos.z)
    }

    // The overflow guard. Runs whether or not the panel is open, because [ and ]
    // reach splitK too, and a crash is no better for having been triggered by a
    // key instead of a slider.
    const st = this.terrain.stats
    if (st.desired > SELECT_BUDGET && LOD.triDeg < MAX_TRI_DEG) {
      LOD.triDeg = Math.min(MAX_TRI_DEG, LOD.triDeg * 1.1)
      this.terrain.invalidate()
      this.message = `selection hit ${st.desired} leaves against a ${SELECT_BUDGET} budget -- triangles backed off to ${LOD.triDeg.toFixed(2)}deg`
      this._relabel()
    }

    if (!this.visible) return

    const pool = (st.slots / SLOT_COUNT) * 100
    const poolClass = pool > 90 ? 't-warn' : pool > 75 ? '' : 't-ok'
    this.live.innerHTML =
      `leaves  ${st.desired} selected / ${st.rendered} drawn   pending ${st.pending}\n` +
      `tris    ${(st.tris / 1000).toFixed(1)}k over ${st.rendered} chunks   gen ${st.lastGenMs.toFixed(1)}ms\n` +
      `<span class="${poolClass}">slots   ${st.slots}/${SLOT_COUNT}  (budget ${SELECT_BUDGET} leaves)</span>\n` +
      `LOD  triangles<=${LOD.triDeg.toFixed(2)}deg   depth<=${MAX_DEPTH}` +
      (this.message ? `\n<span class="t-warn">${this.message}</span>` : '')
  }
}
