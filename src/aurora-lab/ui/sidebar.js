// ---------------------------------------------------------------------------
// The aurora lab's left sidebar: a control column that BUILDS ITSELF from a
// parameter schema and knows nothing else.
//
// It imports nothing. Not three, not the shader, not the lab's own stage. That
// is the whole design and it is worth defending, because the obvious sidebar --
// the one that reaches into the uniform block to read a value back, or asks the
// renderer whether raymarching is on -- welds the panel to one algorithm. The
// lab exists to hold SEVERAL aurora algorithms side by side and switch between
// them, and each one has a different set of knobs. A hand-written row per knob
// goes stale the first time a shader grows a term, and a term with no widget is
// a term nobody ever tunes -- the same failure src/tuner.js records at length.
// So: the host hands over groups of params, this file draws whatever it is
// given, and every edit leaves through `onParam(key, value)`.
//
// THE NUMBER BOX IS NOT CLAMPED to the slider's range, deliberately, and for
// tuner.js's reason: the range is a guess at what is useful and typing past it
// is how you find out the guess was wrong. The range input pins to its end in
// that case, which is honest -- the slider cannot show a value it has no room
// for -- and the number box keeps the truth.
//
// RANGE FIRES ON `input`, NUMBER FIRES ON `change`. Not a detail. Scrubbing is
// only worth anything if the picture moves under the drag, so the range reports
// every tick. The number box must NOT: a keystroke-by-keystroke report of
// "0.0004" passes through 0 and 0.0 on the way, and a host that recompiles or
// re-seeds on each one both stutters and shows you states you never asked for.
//
// GROUPS REMEMBER THEIR OPEN STATE BY TITLE, across rebuilds. Switching
// algorithm calls setGroups again; without the memory every section you had
// opened snaps shut on each switch, which makes A/B-ing two algorithms against
// the same knob unusable -- and it is exactly the comparison the lab is for.
//
// KEYSTROKES MUST NOT ESCAPE. The stage binds bare keys for camera control, so
// typing `w` into a number box would fly the camera while you edit. That bug is
// invisible in the sidebar and infuriating at the stage, so the host element
// swallows keydown whenever the target is a field. If the stage ever binds
// keyup or keypress as well, this guard needs the same treatment.
//
// COLOUR IS LINEAR IN THE STORE AND sRGB IN THE PICKER. `<input type=color>`
// speaks display-referred #rrggbb; the shader wants linear 0..1. Skipping the
// transform does not produce an error, it produces a tint that is roughly twice
// as bright as the one you picked -- and you will look for that in the shader,
// where it is not. Both directions of the transform live in this file because
// they belong to the WIDGET, not to the aurora.
//
// A MISSING STAT PRINTS `??`, NOT `0`, in the warn colour. Same rule as
// src/v2/ui/panel.js: a plausible zero reads as a measurement, and "0 draw
// calls" is a sentence about the renderer, not about the wiring. The key list
// is never hardcoded -- setStats iterates whatever it is handed -- so a new
// stat costs the host one property and this file nothing.
//
// setValue THROWS on a key with no widget rather than shrugging. A tuning file
// pasted in from an older schema is exactly when you want to be told which knob
// no longer exists, and a silent no-op there means half a preset applies and
// the picture is a blend of two tunings that nobody can reproduce.
//
// The CSS below is a template literal. Keep backticks out of it -- design/
// lessons.md has the afternoon that cost, with a SyntaxError reported 100 lines
// from the real one.
// ---------------------------------------------------------------------------

const C = {
  panel: 'rgba(8,14,26,.88)',
  page: '#05080f',
  edge: '#2b4a72',
  ink: '#cfe3ff',
  dim: '#7f95b4',
  head: '#7fd1ff',
  good: '#9dffb0',
  warn: '#c9a227',
  bad: '#ff9a7a',
}

// The row grid. v2-new-grass.html uses 88px 1fr 46px -- label, slider, and a
// read-only value. Here the third column IS the number box, so it has to be
// typed into rather than read, and it has to hold four decimals plus a sign
// ("-0.0031") without ellipsing. 56px does that at 12px monospace once the
// spinner arrows are gone, and the arrows go anyway: they eat 14px of a 56px
// box for a control nobody uses in a panel that is scrubbed, not clicked. The
// label loses the 10px, since it ellipses under its own title tooltip.
const CSS = `
.aur-sb {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: ${C.ink}; background: ${C.panel}; border-right: 1px solid ${C.edge};
  user-select: none;
}
.aur-sb input, .aur-sb select, .aur-sb button {
  font: inherit; color: ${C.ink}; background: #0e1726;
  border: 1px solid ${C.edge}; border-radius: 3px; padding: 3px 5px; min-width: 0;
}
.aur-sb button { cursor: pointer; }
.aur-sb button:hover { background: #17263c; }
.aur-sb button.sb-on { background: #1d3a5f; border-color: #4a7fbf; color: #eaf3ff; }

.aur-sb .sb-top { padding: 8px 10px; border-bottom: 1px solid #1b2c44; }
.aur-sb .sb-alg { width: 100%; }
.aur-sb .sb-blurb { color: ${C.dim}; margin: 4px 0 6px; }
.aur-sb .sb-find { width: 100%; }

.aur-sb .sb-list { flex: 1 1 auto; overflow-y: auto; padding: 6px 10px 10px; }
.aur-sb .sb-list details { border-top: 1px solid #1b2c44; padding: 4px 0; }
.aur-sb .sb-list details:first-child { border-top: 0; }
.aur-sb .sb-list summary { cursor: pointer; color: ${C.head}; padding: 2px 0; }
.aur-sb .sb-list details[hidden] { display: none; }

.aur-sb .sb-row {
  display: grid; grid-template-columns: 78px 1fr 56px; gap: 6px;
  align-items: center; margin: 2px 0;
}
.aur-sb .sb-row[hidden] { display: none; }
.aur-sb .sb-lab {
  color: ${C.dim}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  cursor: help;
}
.aur-sb .sb-lab.sb-off { color: #56688a; }
.aur-sb .sb-row input[type=range] { width: 100%; padding: 0; background: none; border: none; }
.aur-sb .sb-row input[type=number] { width: 100%; text-align: right; padding: 2px 3px;
  font-variant-numeric: tabular-nums; -moz-appearance: textfield; }
.aur-sb .sb-row input[type=number]::-webkit-outer-spin-button,
.aur-sb .sb-row input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.aur-sb .sb-row input[type=color] { width: 100%; height: 20px; padding: 0 2px; }
.aur-sb .sb-row input[type=checkbox] { width: 13px; height: 13px; justify-self: start; accent-color: ${C.head}; }
.aur-sb .sb-row select { width: 100%; }
.aur-sb .sb-wide { grid-column: 2 / 4; }
.aur-sb .sb-hex { color: ${C.dim}; text-align: right; font-variant-numeric: tabular-nums; }
.aur-sb .sb-empty { color: ${C.dim}; padding: 6px 0; }

.aur-sb .sb-foot { border-top: 1px solid #1b2c44; padding: 8px 10px; background: ${C.page}; }
.aur-sb .sb-stats { display: grid; grid-template-columns: auto 1fr; gap: 0 8px; margin-bottom: 8px; }
.aur-sb .sb-sk { color: ${C.dim}; }
.aur-sb .sb-sv { text-align: right; font-variant-numeric: tabular-nums; }
.aur-sb .sb-miss { color: ${C.warn}; text-align: right; }
.aur-sb .sb-presets { display: flex; gap: 4px; margin-bottom: 6px; }
.aur-sb .sb-presets select { flex: 1 1 auto; }
.aur-sb .sb-acts { display: flex; flex-wrap: wrap; gap: 4px; }
.aur-sb .sb-acts button { flex: 1 1 auto; padding: 4px 6px; }
.aur-sb .sb-flash { color: ${C.good}; min-height: 1.5em; margin-top: 5px; }
`

let cssInjected = false

function injectCss() {
  if (cssInjected) return
  cssInjected = true
  const style = document.createElement('style')
  style.id = 'aur-sb-css'
  style.textContent = CSS
  document.head.appendChild(style)
}

// Display precision, from the step alone. An integer step means the value is a
// count and ".00" on a count is noise; a step finer than a hundredth means the
// interesting digits are past the second one, and rounding there would show two
// distinct settings as the same number -- which reads as a dead slider.
function decimals(step) {
  if (Number.isInteger(step)) return 0
  return step < 0.01 ? 4 : 2
}

// Scrubbed floats are start + n * step in binary floating point, so a 0.01 step
// reaches 0.30000000000000004. Same fix as panel.js: seventeen digits in a 56px
// box reads as a broken widget, and only the DISPLAY is rounded -- what left
// through onParam was the real number.
function fmtFloat(v, step) {
  return v.toFixed(decimals(step))
}

// Stats are somebody else's numbers and arrive at whatever precision they were
// measured at. 58.199999 fps is not a fact anyone needs; whole numbers stay
// whole so a triangle count does not sprout a decimal point.
function fmtStat(v) {
  if (typeof v === 'string') return v
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

const linToSrgb = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055)
const srgbToLin = (s) => (s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4))

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0')

// The picker has no room above 1, so an HDR tint is CLAMPED for display only.
// The stored triple is not touched -- push the emission past white in the
// number-shaped knobs and the swatch simply saturates, rather than the picker
// quietly rewriting the value it cannot draw.
function tripleToHex(rgb) {
  return '#' + hex2(linToSrgb(rgb[0])) + hex2(linToSrgb(rgb[1])) + hex2(linToSrgb(rgb[2]))
}

function hexToTriple(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [
    srgbToLin(((n >> 16) & 255) / 255),
    srgbToLin(((n >> 8) & 255) / 255),
    srgbToLin((n & 255) / 255),
  ]
}

// The seven buttons that are not presets. Order is the order of use: get back
// to something known, go somewhere random, move a tuning in or out, look at the
// generated source, then freeze the clock to compare two frames.
const ACTIONS = [
  ['reset', 'reset'],
  ['random', 'randomize'],
  ['copy', 'copy'],
  ['paste', 'paste'],
  ['shader', 'shader'],
  ['step', 'step'],
]

export class Sidebar {
  /**
   * `host` is an existing empty <div> the sidebar fills; it is styled and
   * populated in place rather than replaced, so the lab's flexbox keeps hold of
   * it.
   *
   * All four callbacks are required and every one of them throws if it is
   * missing. Same argument as panel.js: with no host listening, every widget
   * below still lights up, still moves, still shows a new number, and the
   * picture does not change. A control that looks like it worked is worse than
   * one that is missing.
   */
  constructor(host, { algorithms, onAlgorithm, onParam, onAction }) {
    if (!(host instanceof HTMLElement)) throw new Error('Sidebar: host element is required')
    if (!Array.isArray(algorithms) || algorithms.length === 0) throw new Error('Sidebar: algorithms[] is required')
    if (typeof onAlgorithm !== 'function') throw new Error('Sidebar: onAlgorithm(id) is required')
    if (typeof onParam !== 'function') throw new Error('Sidebar: onParam(key, value) is required')
    if (typeof onAction !== 'function') throw new Error('Sidebar: onAction(name) is required')

    this.host = host
    this.onAlgorithm = onAlgorithm
    this.onParam = onParam
    this.onAction = onAction

    this._widgets = new Map() // key -> {param, set(v)}
    this._groups = [] // {title, details, rows: [{row, hay}]}
    this._defaults = new Map() // key -> the value from the last setGroups
    this._openState = new Map() // group title -> bool, survives setGroups
    this._filtering = false
    this._flashTimer = 0

    injectCss()
    this._build(algorithms)
  }

  // --- construction ---------------------------------------------------------

  _build(algorithms) {
    this.host.classList.add('aur-sb')
    this.host.textContent = ''

    // The one guard that keeps the stage flyable while you type. Bound on the
    // host in the bubbling phase, so it catches every field this file will ever
    // add without each of them remembering to stop the event itself -- which is
    // how the equivalent guard in panel.js has to be written, one input at a
    // time, and how it gets forgotten.
    this.host.addEventListener('keydown', (ev) => {
      const t = ev.target
      if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) {
        ev.stopPropagation()
        if (ev.key === 'Enter' && t instanceof HTMLInputElement) t.blur()
      }
    })

    const top = document.createElement('div')
    top.className = 'sb-top'

    this._alg = document.createElement('select')
    this._alg.className = 'sb-alg'
    for (const a of algorithms) {
      const o = document.createElement('option')
      o.value = a.id
      o.textContent = a.name
      this._alg.appendChild(o)
    }
    this._alg.onchange = () => this.onAlgorithm(this._alg.value)

    this._blurb = document.createElement('div')
    this._blurb.className = 'sb-blurb'
    const first = algorithms[0]
    this._blurb.textContent = first.blurb === undefined ? '' : first.blurb

    // Search over key AND label. The label is what you can see and the key is
    // what the shader and the pasted tuning JSON call it, and the two disagree
    // often enough ("line spacing" is `lineFreq`) that filtering on either one
    // alone means half the searches you try come back empty.
    this._find = document.createElement('input')
    this._find.type = 'search'
    this._find.className = 'sb-find'
    this._find.placeholder = 'filter knobs'
    this._find.oninput = () => this._applyFilter()

    top.append(this._alg, this._blurb, this._find)

    this._list = document.createElement('div')
    this._list.className = 'sb-list'

    const foot = document.createElement('div')
    foot.className = 'sb-foot'

    this._stats = document.createElement('div')
    this._stats.className = 'sb-stats'

    const presetRow = document.createElement('div')
    presetRow.className = 'sb-presets'
    this._presets = document.createElement('select')
    // 'preset:' + name, so the host reads one action stream rather than a
    // select callback that has to be wired separately from the buttons beside
    // it and is therefore the one that gets forgotten.
    this._presets.onchange = () => this.onAction('preset:' + this._presets.value)
    const save = document.createElement('button')
    save.textContent = 'save'
    save.onclick = () => this.onAction('savePreset')
    const del = document.createElement('button')
    del.textContent = 'del'
    del.onclick = () => this.onAction('deletePreset')
    presetRow.append(this._presets, save, del)

    const acts = document.createElement('div')
    acts.className = 'sb-acts'
    // Pause is built by hand rather than from ACTIONS: it is the only button
    // with a state to reflect, and setPaused needs the element.
    this._pause = document.createElement('button')
    this._pause.textContent = 'pause'
    this._pause.onclick = () => this.onAction('pause')
    for (const [label, name] of ACTIONS) {
      const b = document.createElement('button')
      b.textContent = label
      b.onclick = () => this.onAction(name)
      if (name === 'step') acts.appendChild(this._pause)
      acts.appendChild(b)
    }

    this._flash = document.createElement('div')
    this._flash.className = 'sb-flash'

    foot.append(this._stats, presetRow, acts, this._flash)
    this.host.append(top, this._list, foot)
  }

  // --- the control list -----------------------------------------------------

  /**
   * Rebuild every control. `groups` is [{title, open, params}] and `values` is
   * a flat {key: value} map that WINS over each param's own `value` where the
   * key is present -- so the schema carries the default and the caller carries
   * the current tuning, and neither has to be rewritten to load the other.
   *
   * The param's `value` is therefore also the reset target: double-clicking a
   * label restores what the schema said, not what was on screen when the lab
   * booted. A preset loaded through `values` does not become the new default,
   * which is the point -- reset means "back to the algorithm as written".
   */
  setGroups(groups, values = {}) {
    this._list.textContent = ''
    this._widgets.clear()
    this._groups = []
    this._defaults.clear()

    for (const g of groups) {
      const details = document.createElement('details')
      // The remembered state wins over the schema's `open`, because the
      // remembered state is a thing the user did and `open` is a guess made
      // before they arrived.
      details.open = this._openState.has(g.title) ? this._openState.get(g.title) : g.open === true
      this._openState.set(g.title, details.open)

      const summary = document.createElement('summary')
      summary.textContent = g.title
      // `open` still holds the pre-toggle value inside the click handler, so
      // the memory records the negation. Recording it on `toggle` instead would
      // also fire for the forced-open pass the filter does, which would erase
      // exactly the state this map exists to protect.
      summary.onclick = () => {
        if (!this._filtering) this._openState.set(g.title, !details.open)
      }
      details.appendChild(summary)

      const rows = []
      for (const p of g.params) {
        const value = Object.prototype.hasOwnProperty.call(values, p.key) ? values[p.key] : p.value
        this._defaults.set(p.key, p.value)
        const rec = this._row(p, value)
        rows.push(rec)
        details.appendChild(rec.row)
      }

      this._list.appendChild(details)
      this._groups.push({ title: g.title, details, rows })
    }

    // A rebuild under a live filter must not show the knobs the filter hides,
    // or switching algorithm silently clears a filter that still has text in
    // its box.
    this._applyFilter()
  }

  _row(p, value) {
    if (typeof p.key !== 'string' || p.key === '') throw new Error('Sidebar: param has no key')
    if (this._widgets.has(p.key)) throw new Error(`Sidebar: duplicate param key '${p.key}'`)

    const row = document.createElement('div')
    row.className = 'sb-row'

    const label = document.createElement('label')
    label.className = 'sb-lab'
    label.textContent = p.label === undefined ? p.key : p.label
    // Set through the DOM PROPERTY, never through an attribute string: the
    // property is never re-parsed, so a hint containing quotes, & or < arrives
    // at the tooltip exactly as written. That is the escaping -- building the
    // attribute by hand is what would need an escape function, and would be the
    // version that breaks on the first apostrophe.
    if (typeof p.hint === 'string' && p.hint !== '') label.title = p.hint
    // A knob you cannot reset is a knob you stop dragging, because every
    // experiment costs you the value you had. Double-click is the gesture with
    // no button to draw and no chord to remember.
    label.ondblclick = () => {
      const def = this._defaults.get(p.key)
      this.setValue(p.key, def)
      this.onParam(p.key, def)
    }

    row.appendChild(label)

    if (p.type === 'float') this._float(p, row, value)
    else if (p.type === 'bool') this._bool(p, row, value)
    else if (p.type === 'color') this._color(p, row, value)
    else if (p.type === 'enum') this._enum(p, row, value)
    else throw new Error(`Sidebar: param '${p.key}' has unknown type '${p.type}'`)

    // The haystack is precomputed and lives on the ROW record rather than being
    // rebuilt per keystroke: the filter runs on every character typed, over
    // every knob in the algorithm, and lowercasing forty labels per keystroke is
    // work with nothing to show for it.
    return { row, hay: (p.key + ' ' + (p.label === undefined ? '' : p.label)).toLowerCase() }
  }

  _float(p, row, value) {
    if (!Number.isFinite(p.min) || !Number.isFinite(p.max) || !Number.isFinite(p.step)) {
      throw new Error(`Sidebar: float param '${p.key}' needs finite min, max and step`)
    }

    const range = document.createElement('input')
    range.type = 'range'
    range.min = String(p.min)
    range.max = String(p.max)
    range.step = String(p.step)

    const num = document.createElement('input')
    num.type = 'number'
    num.step = String(p.step)
    // No min/max attribute. See the header: the slider's range is a guess and
    // the box is how you go past it.

    // The last value this knob actually holds, kept here rather than read back
    // off a widget. Neither widget can be trusted to remember it: the range
    // CLAMPS what it is given, so a knob pushed to 40 through a 6-ended slider
    // reads back as 6, and the number box is empty exactly when it is being
    // recovered from. Restoring from the range instead would quietly undo the
    // out-of-range value the box exists to allow.
    let live = value

    range.oninput = () => {
      live = parseFloat(range.value)
      num.value = fmtFloat(live, p.step)
      this.onParam(p.key, live)
    }
    // `change`, not `input`: reporting per keystroke means "0.0004" is reported
    // as 0, then 0.0, then 0.00 on the way to the value that was meant.
    num.onchange = () => {
      const v = parseFloat(num.value)
      // An emptied or half-typed box would otherwise sit there showing a value
      // the shader does not have. Put the live one back rather than pushing NaN
      // into a uniform, where it turns the whole draw black and looks like a
      // shader bug.
      if (!Number.isFinite(v)) {
        num.value = fmtFloat(live, p.step)
        return
      }
      live = v
      range.value = String(v) // pins to an end when v is outside the range
      this.onParam(p.key, v)
    }

    row.append(range, num)
    this._register(p, (v) => {
      if (!Number.isFinite(v)) throw new Error(`Sidebar.setValue('${p.key}'): expected a number, got ${v}`)
      live = v
      range.value = String(v)
      // Never over a box being typed into: setValue is also how a host that
      // animates a knob pushes each frame in, and rewriting the field under the
      // cursor eats the digits.
      if (document.activeElement !== num) num.value = fmtFloat(v, p.step)
    }, value)
  }

  _bool(p, row, value) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.onchange = () => this.onParam(p.key, box.checked)
    row.append(box, document.createElement('span'))
    this._register(p, (v) => {
      if (typeof v !== 'boolean') throw new Error(`Sidebar.setValue('${p.key}'): expected a boolean, got ${v}`)
      box.checked = v
    }, value)
  }

  _color(p, row, value) {
    const pick = document.createElement('input')
    pick.type = 'color'
    const hex = document.createElement('span')
    hex.className = 'sb-hex'

    // `input`, so the picker's own drag is live -- a colour chosen against a
    // still frame is chosen against the wrong thing, since the aurora's own
    // emission is what decides whether a tint reads at all.
    pick.oninput = () => {
      hex.textContent = pick.value.slice(1)
      this.onParam(p.key, hexToTriple(pick.value))
    }

    row.append(pick, hex)
    this._register(p, (v) => {
      if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) {
        throw new Error(`Sidebar.setValue('${p.key}'): expected a linear [r, g, b] triple`)
      }
      pick.value = tripleToHex(v)
      hex.textContent = pick.value.slice(1)
    }, value)
  }

  _enum(p, row, value) {
    if (!Array.isArray(p.options) || p.options.length === 0) {
      throw new Error(`Sidebar: enum param '${p.key}' needs options[]`)
    }
    const sel = document.createElement('select')
    sel.className = 'sb-wide'
    p.options.forEach((name, i) => {
      const o = document.createElement('option')
      o.value = String(i)
      o.textContent = name
      sel.appendChild(o)
    })
    // The INDEX goes out, not the name: the value ends up in a shader as an
    // int, and a panel that reports 'neon' where the tuning JSON holds 1 makes
    // copy and paste disagree with each other.
    sel.onchange = () => this.onParam(p.key, Number(sel.value))

    row.append(sel)
    this._register(p, (v) => {
      // A name is accepted as well as an index, because a hand-written preset
      // is far more readable with 'duotone' in it than with 2, and refusing it
      // here would push that translation onto every caller.
      const i = typeof v === 'string' ? p.options.indexOf(v) : v
      if (!Number.isInteger(i) || i < 0 || i >= p.options.length) {
        throw new Error(`Sidebar.setValue('${p.key}'): ${v} is not one of ${p.options.join(', ')}`)
      }
      sel.value = String(i)
    }, value)
  }

  // Every widget goes into the map through here and is then given its initial
  // value through the SAME setter the host will use later. Building the widget
  // one way and updating it another is how a type ends up displaying correctly
  // on load and silently ignoring setValue afterwards.
  _register(p, set, value) {
    this._widgets.set(p.key, { param: p, set })
    set(value)
  }

  // --- pushing values back in ----------------------------------------------

  /**
   * Point one widget at a value the sidebar did not produce -- a loaded preset,
   * a pasted tuning, a knob the host randomized -- WITHOUT firing onParam.
   *
   * The missing callback is the point, and panel.js's header has the long
   * version: echoing a value back at the host that just sent it is how a panel
   * and its host ping-pong, and here every leg of that would be a uniform
   * upload or a shader rebuild.
   */
  setValue(key, value) {
    const w = this._widgets.get(key)
    if (w === undefined) throw new Error(`Sidebar.setValue: no widget for key '${key}'`)
    w.set(value)
  }

  setValues(values) {
    for (const key of Object.keys(values)) this.setValue(key, values[key])
  }

  /** Select an algorithm without firing onAlgorithm. See setValue. */
  setAlgorithm(id) {
    this._alg.value = String(id)
    // An id with no <option> leaves a <select> showing its first entry, so the
    // picker would claim an algorithm the stage is not running.
    if (this._alg.value !== String(id)) throw new Error(`Sidebar.setAlgorithm: unknown algorithm '${id}'`)
  }

  setBlurb(text) {
    this._blurb.textContent = text === undefined || text === null ? '' : String(text)
  }

  /** Fill the preset picker. `selected` may be absent -- nothing is chosen then. */
  setPresets(names, selected) {
    this._presets.textContent = ''
    for (const name of names) {
      const o = document.createElement('option')
      o.value = name
      o.textContent = name
      this._presets.appendChild(o)
    }
    if (selected !== undefined && selected !== null) this._presets.value = String(selected)
  }

  setPaused(on) {
    this._pause.classList.toggle('sb-on', on === true)
    // The label says what pressing it does, not what the state is; the lit
    // class carries the state. The action name stays 'pause' either way, so the
    // host reads one name rather than two that mean the same toggle.
    this._pause.textContent = on === true ? 'resume' : 'pause'
  }

  // --- footer ---------------------------------------------------------------

  /**
   * Draw a flat {key: value} object as a two-column grid. The key list is the
   * object's own -- iterate, never enumerate -- so a stat the stage starts
   * measuring appears here with no edit to this file. Anything that is not a
   * finite number and not a non-empty string prints `??` in the warn colour:
   * see the header for why a zero is the worse lie.
   */
  setStats(obj) {
    this._stats.textContent = ''
    for (const key of Object.keys(obj)) {
      const v = obj[key]
      const ok = Number.isFinite(v) || (typeof v === 'string' && v !== '')

      const k = document.createElement('span')
      k.className = 'sb-sk'
      k.textContent = key

      const val = document.createElement('span')
      val.className = ok ? 'sb-sv' : 'sb-miss'
      val.textContent = ok ? fmtStat(v) : '??'

      this._stats.append(k, val)
    }
  }

  /**
   * A transient line in the footer -- "copied", "clipboard refused", "preset
   * saved". It clears itself, because the alternative is a stale message that
   * still says "copied" long after the copy it refers to, which is how a panel
   * starts lying about the last thing you did.
   */
  flash(message) {
    this._flash.textContent = message === undefined ? '' : String(message)
    clearTimeout(this._flashTimer)
    this._flashTimer = setTimeout(() => {
      this._flash.textContent = ''
    }, 2200)
  }

  // --- filtering ------------------------------------------------------------

  /**
   * Hide rows whose key and label both miss the search text. While a filter is
   * live every group is forced open -- a match hidden inside a collapsed
   * section is a match the search failed to find, as far as anyone looking at
   * the panel can tell -- and clearing the box restores exactly the open/closed
   * state the user had arranged, which is what `_openState` is holding onto.
   *
   * A group with no surviving rows is hidden outright rather than left as an
   * empty heading, so what remains reads as the answer to the search.
   */
  _applyFilter() {
    const q = this._find.value.trim().toLowerCase()
    this._filtering = q !== ''

    for (const g of this._groups) {
      let shown = 0
      for (const rec of g.rows) {
        const hit = q === '' || rec.hay.includes(q)
        rec.row.hidden = !hit
        if (hit) shown++
      }
      g.details.hidden = this._filtering && shown === 0
      g.details.open = this._filtering ? true : this._openState.get(g.title) === true
    }
  }
}
