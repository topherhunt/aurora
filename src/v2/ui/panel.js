import { TRI_BUDGET, CALL_BUDGET } from '../../budget.js'
import { TOOLS, TOOL_KEYS } from '../edit/editor.js'

// ---------------------------------------------------------------------------
// The v2 status + tools panel. Replaces v1's `#desktop-hud` on the v2 route.
//
// v1's HUD is a column of prose lines -- one fact per line, roughly twenty of
// them, running a third of the way down a 1080p screen. That shape exists
// because its OTHER surface is a canvas texture read at arm's length inside a
// headset (src/hud.js), where a dense grid is unreadable. On a monitor it is the
// wrong shape twice over: it wastes the horizontal axis entirely, and it makes
// finding one number a linear scan.
//
// So this panel is a two-column key/value GRID -- the same facts in about a
// third of the height -- plus the two zones v1 has nowhere to put: the tool row
// and the selected object's editable fields. It is desktop-only by design. §18:
// "The XR canvas mirror keeps showing status only. Editing is a desktop
// activity and the gizmo has no controller binding." The host keeps v1's `Hud`
// for the headset; there is deliberately no XR mirror in here.
//
// COLOURS ARE v1's, and the duplication is on purpose. `##` heading, `!!`
// wrong, `++` good, `%%` measurement -- the exact table and the exact meanings
// from PREFIX_COLORS in src/hud.js, which does not export them. Two panels that
// disagree about what red means are worse than one ugly panel, so if that table
// moves, this copy moves with it.
//
// POINTER-EVENTS ARE OFF except on the widgets. Mouse-look starts anywhere on
// the canvas, and a panel that eats a drag beginning over the fps readout feels
// like the camera has stuck. Only buttons, inputs, rows and the header take the
// pointer.
//
// REPAINT IS 4 Hz, driven by the host calling `setStats`. Same reasoning as
// `Hud.paint`: the numbers are unreadable faster than that and innerHTML is not
// free. The context fields are NOT rebuilt on that clock -- they hold focus and
// a half-typed number -- they are refreshed in place and rebuilt only when the
// selection changes.
//
// `setStats` takes a flat object; the host fills what it can and anything
// missing prints as `??` in the warn colour rather than as a plausible zero:
//   { fps, ms, tris, calls, resident, drawn, queued, triDeg,
//     x, y, z, ground, cell, snowHere, snowBase, mode }
// `cell` is the sampling spacing of the chunk under the cursor -- the "am I
// actually seeing 10 cm" readout -- and gets a row of its own.
// ---------------------------------------------------------------------------

const COLORS = {
  head: '#7fd1ff', // '##'
  bad: '#ff9a7a', // '!!'
  good: '#9dffb0', // '++'
  meas: '#ff5f52', // '%%'
  body: '#cfe3ff',
  dim: '#7f95b4',
}

// Same one line as src/hud.js. Ids come out of a document that may have been
// imported from a file, so every interpolated string goes through it.
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const num = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : null)

const CSS = `
#v2-panel {
  position: fixed; top: 0; left: 0; z-index: 30; width: 340px; max-height: 34vh;
  display: flex; flex-direction: column;
  font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; color: ${COLORS.body};
  background: rgba(8,14,26,.9); border-right: 1px solid #2b4a72; border-bottom: 1px solid #2b4a72;
  pointer-events: none; user-select: none;
}
#v2-panel .p-i { pointer-events: auto; }
#v2-panel .p-head { padding: 4px 8px; color: ${COLORS.head}; cursor: pointer;
  border-bottom: 1px solid #1e3253; display: flex; justify-content: space-between; }
#v2-panel .p-body { overflow-y: auto; padding: 0 0 4px; }
#v2-panel.p-shut .p-body { display: none; }
#v2-panel .p-z { padding: 4px 8px; border-top: 1px solid #16273f; }
#v2-panel .p-z:first-child { border-top: 0; }
#v2-panel .p-t { color: ${COLORS.dim}; margin-bottom: 2px; }
#v2-panel .p-g { display: grid; grid-template-columns: 5.5em 1fr 5.5em 1fr; gap: 0 6px; }
#v2-panel .p-k { color: ${COLORS.dim}; }
#v2-panel .p-wide { grid-column: 1 / 5; }
#v2-panel .p-cell { grid-column: 1 / 5; display: flex; justify-content: space-between;
  margin-top: 2px; padding-top: 2px; border-top: 1px dashed #1e3253; }
#v2-panel .p-cell b { color: ${COLORS.meas}; font-size: 13px; font-weight: 600; }
#v2-panel .c-head { color: ${COLORS.head}; }
#v2-panel .c-bad { color: ${COLORS.bad}; }
#v2-panel .c-good { color: ${COLORS.good}; }
#v2-panel .c-meas { color: ${COLORS.meas}; }
#v2-panel .p-btn { background: #17304f; color: ${COLORS.body}; border: 1px solid #2b4a72;
  border-radius: 3px; font: 11px ui-monospace, Menlo, monospace; padding: 2px 5px; cursor: pointer; }
#v2-panel .p-btn:hover { background: #1f4570; }
#v2-panel .p-btn[disabled] { opacity: .4; cursor: default; }
#v2-panel .p-btn.p-on { background: #2f6fb0; border-color: #7fd1ff; color: #eaf4ff; }
#v2-panel .p-btn small { color: ${COLORS.dim}; margin-left: 3px; }
#v2-panel .p-on small { color: #cfe3ff; }
#v2-panel .p-flow { display: flex; flex-wrap: wrap; gap: 3px; }
#v2-panel .p-fields { display: grid; grid-template-columns: 6em 1fr; gap: 2px 6px; align-items: center; }
#v2-panel .p-scrub { cursor: ew-resize; }
#v2-panel .p-scrub:hover { color: ${COLORS.head}; }
#v2-panel input.p-num { width: 100%; background: #0e1728; color: ${COLORS.body};
  border: 1px solid #2b4a72; border-radius: 2px; font: 11px ui-monospace, Menlo, monospace; padding: 1px 3px; }
#v2-panel details { margin-top: 2px; }
#v2-panel summary { cursor: pointer; color: ${COLORS.head}; }
#v2-panel .p-row { display: flex; gap: 4px; align-items: center; padding: 1px 0 1px 8px; cursor: pointer; }
#v2-panel .p-row:hover { background: #12203a; }
#v2-panel .p-row.p-sel { background: #1b3a5e; }
#v2-panel .p-row .p-id { width: 3.2em; color: ${COLORS.head}; }
#v2-panel .p-row .p-sum { flex: 1; color: ${COLORS.dim}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#v2-panel .p-mini { background: none; border: 0; color: ${COLORS.dim}; cursor: pointer;
  font: 11px ui-monospace, Menlo, monospace; padding: 0 3px; }
#v2-panel .p-mini:hover { color: ${COLORS.bad}; }
#v2-panel .p-err { color: ${COLORS.bad}; padding: 2px 8px; white-space: pre-wrap; }
#v2-panel .p-gz { margin-bottom: 3px; }

/* The context menu lives on <body>, not in the panel: it opens at the CURSOR,
   which is out in the viewport, and a child of a 340px panel with its own
   scrolling body cannot be positioned there. */
#v2-menu {
  position: fixed; z-index: 40; min-width: 130px; padding: 2px;
  font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; color: ${COLORS.body};
  background: rgba(8,14,26,.96); border: 1px solid #2b4a72; border-radius: 3px;
  box-shadow: 0 2px 10px rgba(0,0,0,.5); user-select: none;
}
#v2-menu[hidden] { display: none; }
#v2-menu button { display: block; width: 100%; text-align: left; background: none; border: 0;
  color: inherit; font: inherit; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
#v2-menu button:hover { background: #1f4570; color: #eaf4ff; }
`

export class Panel {
  constructor({ layers, editor, onTool, onAction }) {
    if (typeof onTool !== 'function') throw new Error('Panel: onTool(name) is required')
    if (typeof onAction !== 'function') throw new Error('Panel: onAction(name) is required')
    this.layers = layers
    this.editor = editor
    this.onTool = onTool
    this.onAction = onAction

    this.root = document.getElementById('v2-panel')
    if (!this.root) throw new Error('Panel: v2.html must contain <div id="v2-panel">')

    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)

    this.open = true
    this._epoch = -1
    this._selSig = ''
    this._listSig = ''
    this._gizmoSig = ''
    this._rows = [] // {row, input, valueEl}
    this._scrubbing = false
    this._openGroups = new Set(['snow', 'lake', 'river', 'road'])

    this._build()
    this.syncSelection()

    // H toggles, matching v1's HUD key. Skipped while a field has focus, or
    // typing an `h` into the radius box would fold the panel away mid-edit.
    // The host must NOT also bind H to this panel; it owns H for the XR Hud.
    window.addEventListener('keydown', (ev) => {
      if (ev.key.toLowerCase() !== 'h' || ev.ctrlKey || ev.metaKey || ev.altKey) return
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return
      this.toggle()
    })
  }

  toggle() {
    this.open = !this.open
    this.root.classList.toggle('p-shut', !this.open)
    this._head.lastElementChild.textContent = this.open ? 'H to hide' : 'H'
  }

  // --- the 4 Hz surface -----------------------------------------------------

  /** Called ~4 Hz from the frame loop. See the header for the expected keys. */
  setStats(s) {
    if (!this.open) return
    this._paintStatus(s)

    // A click in the VIEWPORT changes the selection without changing the
    // document, so neither the host nor `epoch` necessarily says so. Rather
    // than make main.js remember to call syncSelection() after every forwarded
    // pointer event -- one forgotten call and the context fields silently
    // describe the previously selected object -- the selection is compared here
    // at the same 4 Hz. syncSelection() stays public for the paths that want
    // the panel correct before the next tick.
    const sel = this.editor.selection
    const selSig = sel === null ? '-' : `${sel.kind}:${sel.id}:${sel.index}`
    if (selSig !== this._selSig) {
      this._selSig = selSig
      this.syncSelection()
    }

    // The gizmo mode also changes from the KEYBOARD (G/R/S), which the panel
    // never hears about. Same 4 Hz comparison as the selection, and for the same
    // reason: cheaper than a callback the host has to remember to fire.
    this._paintGizmo()

    // The brush's own readouts -- how many texels are pinned at the encoding's
    // ceiling, whether the sculpt is saved -- move without the DOCUMENT moving,
    // so they cannot ride the epoch cache below.
    if (this.editor.tool === 'sculpt') {
      this._refreshFields()
      // And the undo button: a stroke does not move the document epoch, so
      // without this the button stays greyed out over a stack with strokes in
      // it -- which reads as "sculpting cannot be undone".
      this._syncUndo()
    }

    // Tools are switched by key as well as by button (1..6), and the keyboard
    // path never reaches the panel. Same 4 Hz comparison, one class toggle.
    this._paintTools()

    // Everything below is document-shaped, so it only redraws when the document
    // moved. `epoch` is bumped by every mutation (§18), which makes it exactly
    // the right cache key -- including for undo, which is otherwise invisible.
    if (this.layers.epoch === this._epoch) return
    this._epoch = this.layers.epoch
    this._bytes.textContent = `${this.editor.bytes} B`
    this._paintLayers()
    this._refreshFields()
    this._syncUndo()
  }

  /** Called when `editor.selection` changes. Rebuilds the context fields. */
  syncSelection() {
    const sel = this.editor.selection
    this._selSig = sel === null ? '-' : `${sel.kind}:${sel.id}:${sel.index}`
    this._buildFields()
    this._paintGizmo()
    this._paintTools()
    this._paintLayers()
    this._syncUndo()
  }

  setError(msg) {
    this._err.textContent = msg ? String(msg) : ''
  }

  // --- construction ---------------------------------------------------------

  _build() {
    this.root.className = ''
    this.root.innerHTML = ''

    this._head = document.createElement('div')
    this._head.className = 'p-head p-i'
    const title = document.createElement('span')
    title.textContent = 'AURORA v2'
    const hint = document.createElement('span')
    hint.textContent = 'H to hide'
    this._head.append(title, hint)
    this._head.onclick = () => this.toggle()

    this._body = document.createElement('div')
    this._body.className = 'p-body'

    this._status = document.createElement('div')
    this._status.className = 'p-z p-g'

    const tools = document.createElement('div')
    tools.className = 'p-z'
    this._tools = document.createElement('div')
    this._tools.className = 'p-flow'
    this._toolBtns = TOOLS.map((name, i) => {
      const b = document.createElement('button')
      b.className = 'p-btn p-i'
      b.innerHTML = `${escapeHtml(name)}<small>${escapeHtml(TOOL_KEYS[i])}</small>`
      b.onclick = () => {
        this.onTool(name)
        this._paintTools()
      }
      this._tools.appendChild(b)
      return b
    })
    tools.appendChild(this._tools)

    this._ctx = document.createElement('div')
    this._ctx.className = 'p-z'
    // The gizmo's own mode buttons. G/R/S are bound on the window and always
    // were, but a keyboard shortcut nobody told you about is not a control --
    // "I don't see a way to change its size" is what an invisible mode looks
    // like from the outside. Which modes exist is the EDITOR's answer: a snow
    // point cannot rotate and the panel should not be the one deciding that.
    this._gizmoRow = document.createElement('div')
    this._gizmoRow.className = 'p-flow p-gz'
    this._fields = document.createElement('div')
    this._fields.className = 'p-fields'
    this._ctx.append(this._gizmoRow, this._fields)

    this._layersZone = document.createElement('div')
    this._layersZone.className = 'p-z'

    const foot = document.createElement('div')
    foot.className = 'p-z p-flow'
    const act = (label, name) => {
      const b = document.createElement('button')
      b.className = 'p-btn p-i'
      b.textContent = label
      b.onclick = () => this.onAction(name)
      foot.appendChild(b)
      return b
    }
    act('save', 'save')
    act('load', 'load')
    act('export', 'export')
    act('import', 'import')
    this._undoBtn = act('undo', 'undo')
    this._redoBtn = act('redo', 'redo')
    this._bytes = document.createElement('span')
    // The compactness claim, shown rather than asserted (§18: the document is
    // kilobytes by construction). A byte count that starts climbing into the
    // hundreds of kB means something baked has leaked into the stored form.
    this._bytes.className = 'c-good'
    this._bytes.style.marginLeft = 'auto'
    foot.appendChild(this._bytes)

    this._err = document.createElement('div')
    this._err.className = 'p-err'

    this._body.append(this._status, tools, this._ctx, this._layersZone, foot, this._err)
    this.root.append(this._head, this._body)

    this._menu = document.createElement('div')
    this._menu.id = 'v2-menu'
    this._menu.hidden = true
    document.body.appendChild(this._menu)
    // Capture phase, so the press that dismisses the menu is also the press that
    // does whatever it was going to do in the viewport. A menu you have to close
    // before you can click anything is a modal, and this is not one.
    window.addEventListener('pointerdown', (ev) => {
      if (this._menu.hidden || this._menu.contains(ev.target)) return
      this.hideMenu()
    }, true)
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this.hideMenu()
    })
  }

  // --- the context menu -----------------------------------------------------

  /**
   * Open a menu of `[{label, run}]` at viewport pixel (x, y). An empty list
   * closes any open menu and returns false, which is what a right-click on
   * nothing should do -- the host does not have to test for it.
   *
   * The items come from `editor.menuFor(ev)` fully formed, `run` included. The
   * panel draws labels and calls closures; it never works out what is legal to
   * do to a river point.
   */
  showMenu(x, y, items) {
    this.hideMenu()
    if (!Array.isArray(items) || items.length === 0) return false

    for (const it of items) {
      if (typeof it.run !== 'function') throw new Error(`Panel.showMenu: item ${it.label} has no run()`)
      const b = document.createElement('button')
      b.textContent = it.label
      b.onclick = () => {
        this.hideMenu()
        it.run()
        // The run() closures mutate the document and often the selection, and
        // both zones are otherwise only repainted on the 4 Hz tick. Doing it
        // here means the panel is right in the same frame as the click.
        this.syncSelection()
      }
      this._menu.appendChild(b)
    }

    this._menu.hidden = false
    // Placed AFTER unhiding, because a hidden element measures 0x0 and would
    // always look like it fits.
    const w = this._menu.offsetWidth
    const h = this._menu.offsetHeight
    this._menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - w - 2))}px`
    this._menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - h - 2))}px`
    return true
  }

  hideMenu() {
    this._menu.hidden = true
    this._menu.innerHTML = ''
  }

  // --- zone 1: status -------------------------------------------------------

  _paintStatus(s) {
    const triPct = Number.isFinite(s.tris) ? Math.round((s.tris / TRI_BUDGET) * 100) : null
    const cells = []
    const kv = (k, v, cls = '') =>
      cells.push(
        `<span class="p-k">${escapeHtml(k)}</span>` +
          (v === null
            ? '<span class="c-bad">??</span>'
            : `<span class="${cls}">${escapeHtml(v)}</span>`)
      )

    kv('fps', num(s.fps), s.fps < 45 ? 'c-bad' : s.fps >= 70 ? 'c-good' : '')
    kv('ms', num(s.ms, 1))
    kv('tris', triPct === null ? null : `${(s.tris / 1000).toFixed(0)}k ${triPct}%`, triPct > 100 ? 'c-bad' : triPct > 75 ? '' : 'c-good')
    kv('calls', Number.isFinite(s.calls) ? String(s.calls) : null, s.calls > CALL_BUDGET ? 'c-bad' : '')
    kv('chunks', Number.isFinite(s.resident) ? `${s.resident}/${s.drawn}` : null)
    kv('queued', Number.isFinite(s.queued) ? String(s.queued) : null, s.queued > 64 ? 'c-bad' : '')
    kv('triDeg', num(s.triDeg, 2))
    kv('mode', s.mode ? String(s.mode) : null, 'c-head')
    kv('ground', num(s.ground, 1))
    kv('snow', Number.isFinite(s.snowHere) ? `${s.snowHere.toFixed(0)} (${s.snowBase.toFixed(0)})` : null)

    const pos =
      Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z)
        ? `${s.x.toFixed(1)}  ${s.y.toFixed(1)}  ${s.z.toFixed(1)}`
        : null
    cells.push(
      `<span class="p-wide"><span class="p-k">pos </span>${
        pos === null ? '<span class="c-bad">??</span>' : escapeHtml(pos)
      }</span>`
    )

    // The one number this whole world exists to make true: the sampling spacing
    // of the ground she is standing on. §18's "down to 10 cm" is a claim about
    // THIS value, so it is the only readout with its own row and its own size.
    //
    // "underfoot" and not "under cursor", which is what this said while it was
    // showing terrain.stats.finestCell -- the finest chunk ANYWHERE on screen,
    // which is pinned at the depth cap by whatever the camera is nearest to and
    // therefore read 6.3 cm in every situation anyone ever looked at it in. It
    // now reads terrain.stats.cellUnderfoot and it moves.
    const cell =
      s.cell === null || s.cell === undefined || !Number.isFinite(s.cell)
        ? '??'
        : s.cell < 1
          ? `${(s.cell * 100).toFixed(1)} cm`
          : `${s.cell.toFixed(2)} m`
    cells.push(`<span class="p-cell"><span class="p-k">cell underfoot</span><b>${escapeHtml(cell)}</b></span>`)

    this._status.innerHTML = cells.join('')
  }

  // --- zone 2: tools --------------------------------------------------------

  _paintTools() {
    for (let i = 0; i < TOOLS.length; i++) {
      this._toolBtns[i].classList.toggle('p-on', this.editor.tool === TOOLS[i])
    }
  }

  // --- zone 3: context fields ----------------------------------------------

  // The mode row: gizmo modes with something selected, brush modes with the
  // sculpt tool armed. The editor decides which -- see Editor.modeButtons -- so
  // this stays one row of buttons that draws whatever it is handed.
  _paintGizmo() {
    const g = this.editor.modeButtons()
    const sig = g === null ? '-' : `${g.modes.join(',')}:${g.active}`
    if (sig === this._gizmoSig) return
    this._gizmoSig = sig
    this._gizmoRow.innerHTML = ''
    if (g === null) return
    for (const m of g.modes) {
      const b = document.createElement('button')
      b.className = 'p-btn p-i'
      const key = g.keys?.[m]
      b.innerHTML = escapeHtml(m) + (key ? `<small>${escapeHtml(key.toUpperCase())}</small>` : '')
      b.classList.toggle('p-on', m === g.active)
      b.onclick = () => {
        g.set(m)
        // The mode changes which FIELDS exist (strength is metres per second for
        // raise, a rate for smooth), so this repaints both rows and not just its
        // own. The signature above has already moved, so _paintGizmo redraws.
        this._paintGizmo()
        this._buildFields()
      }
      this._gizmoRow.appendChild(b)
    }
  }

  _buildFields() {
    this._fields.innerHTML = ''
    this._rows = []
    const rows = this.editor.status()
    if (!rows.length) {
      const empty = document.createElement('div')
      empty.className = 'p-k'
      empty.style.gridColumn = '1 / 3'
      empty.textContent = 'nothing selected'
      this._fields.appendChild(empty)
      return
    }

    for (const row of rows) {
      const k = document.createElement('div')
      k.className = 'p-k'
      k.textContent = row.label

      if (typeof row.set !== 'function') {
        const v = document.createElement('div')
        v.textContent = typeof row.value === 'number' ? row.value.toFixed(2).replace(/\.00$/, '') : String(row.value)
        if (row.unit) v.textContent += ` ${row.unit}`
        this._fields.append(k, v)
        this._rows.push({ row, input: null, valueEl: v })
        continue
      }

      const input = document.createElement('input')
      input.type = 'number'
      input.className = 'p-num p-i'
      input.value = String(row.value)
      if (row.step !== undefined) input.step = String(row.step)
      // Deliberately NOT clamped by the input's own min/max: the same reasoning
      // as tuner.js's number boxes -- the range is a guess at what is useful and
      // typing past it is how you find out the guess was wrong. The setter
      // clamps where a value would actually be invalid.
      input.onchange = () => {
        const v = parseFloat(input.value)
        if (Number.isFinite(v)) row.set(v, true)
      }
      input.onkeydown = (ev) => {
        // Otherwise typing `1` in a width field switches to the snowline tool
        // and `g` moves the gizmo. The panel owns the keyboard while a field has
        // it.
        ev.stopPropagation()
        if (ev.key === 'Enter') input.blur()
      }

      k.classList.add('p-i', 'p-scrub')
      k.title = 'drag left/right to scrub'
      this._attachScrub(k, row, input)

      this._fields.append(k, input)
      this._rows.push({ row, input, valueEl: null })
    }
  }

  /**
   * Drag the LABEL to scrub the value, the way tuner.js gives every knob a
   * slider: the useful range of `radius` is 10 m to 4 km and typing four digits
   * to find out what 900 looks like is not tuning, it is arithmetic.
   *
   * Ticks call `set(v, false)` -- change the document, do NOT push undo -- and
   * the release calls `set(v, true)`. A commit per tick would put fifty entries
   * on a 64-deep stack for one drag and make undo useless, which is the same
   * reason the gizmo's own drag only commits on mouse-up.
   */
  _attachScrub(labelEl, row, input) {
    labelEl.addEventListener('pointerdown', (ev) => {
      ev.preventDefault()
      const startX = ev.clientX
      const startV = parseFloat(input.value)
      if (!Number.isFinite(startV)) return
      const step = Number.isFinite(row.step) ? row.step : 1
      this._scrubbing = true
      labelEl.setPointerCapture(ev.pointerId)

      // One step per 4 px: fine enough to land on a value with a wrist movement,
      // coarse enough that a 300 px drag crosses 75 steps of the range.
      const clamp = (v) => {
        if (Number.isFinite(row.min)) v = Math.max(row.min, v)
        if (Number.isFinite(row.max)) v = Math.min(row.max, v)
        return v
      }
      const move = (e) => {
        const v = clamp(startV + Math.round((e.clientX - startX) / 4) * step)
        input.value = String(v)
        row.set(v, false)
      }
      const up = (e) => {
        labelEl.removeEventListener('pointermove', move)
        labelEl.removeEventListener('pointerup', up)
        labelEl.releasePointerCapture(ev.pointerId)
        this._scrubbing = false
        row.set(clamp(startV + Math.round((e.clientX - startX) / 4) * step), true)
      }
      labelEl.addEventListener('pointermove', move)
      labelEl.addEventListener('pointerup', up)
    })
  }

  /**
   * Push new values into the existing widgets without rebuilding them -- a
   * rebuild would drop focus and eat a half-typed number. Falls back to a full
   * rebuild only when the field LIST itself changed underneath.
   */
  _refreshFields() {
    if (this._scrubbing) return
    const rows = this.editor.status()
    if (rows.length !== this._rows.length || rows.some((r, i) => r.label !== this._rows[i].row.label)) {
      this._buildFields()
      return
    }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      const slot = this._rows[i]
      slot.row = r
      if (slot.input) {
        if (document.activeElement !== slot.input) slot.input.value = String(r.value)
      } else {
        slot.valueEl.textContent =
          (typeof r.value === 'number' ? r.value.toFixed(2).replace(/\.00$/, '') : String(r.value)) +
          (r.unit ? ` ${r.unit}` : '')
      }
    }
  }

  // --- zone 3b: the layer list ---------------------------------------------

  _paintLayers() {
    const items = this.editor.layerList()
    const sel = this.editor.selection
    const sig =
      items.map((it) => `${it.kind}:${it.label}:${it.summary}`).join('|') +
      '#' + (sel ? `${sel.kind}:${sel.id}:${sel.index}` : '-') +
      '#' + [...this.editor.hidden].sort().join(',')
    if (sig === this._listSig) return
    this._listSig = sig

    this._layersZone.innerHTML = ''
    const kinds = ['snow', 'lake', 'river', 'road']
    for (const kind of kinds) {
      const mine = items.filter((it) => it.kind === kind)
      const d = document.createElement('details')
      d.open = this._openGroups.has(kind)
      const sum = document.createElement('summary')
      sum.className = 'p-i'
      sum.textContent = `${kind} (${mine.length})`
      sum.onclick = () => {
        // `open` still holds the pre-toggle value inside the click handler.
        if (d.open) this._openGroups.delete(kind)
        else this._openGroups.add(kind)
      }
      d.appendChild(sum)
      for (const it of mine) d.appendChild(this._layerRow(it, sel))
      this._layersZone.appendChild(d)
    }
  }

  _layerRow(it, sel) {
    const row = document.createElement('div')
    row.className = 'p-row p-i'
    if (sel && sel.kind === it.kind && sel.id === it.id && sel.index === it.index) row.classList.add('p-sel')
    row.onclick = (ev) => {
      if (ev.target !== row && ev.target.tagName === 'BUTTON') return
      this.editor.select(it.kind, it.id, it.index)
      this.syncSelection()
    }

    // label, not id: a snow point's id is null (it is addressed by index), and
    // `id` is what goes back to the editor untouched.
    const id = document.createElement('span')
    id.className = 'p-id'
    id.textContent = it.label

    const sum = document.createElement('span')
    sum.className = 'p-sum'
    sum.textContent = it.summary

    const eye = document.createElement('button')
    eye.className = 'p-mini p-i'
    const visible = this.editor.isVisible(it.kind, it.id, it.index)
    eye.textContent = visible ? 'o' : '-'
    eye.title = visible ? 'hide' : 'show'
    eye.onclick = (ev) => {
      ev.stopPropagation()
      this.editor.setVisible(it.kind, it.id, it.index, !visible)
      this._listSig = '' // force a repaint: the signature includes the hidden set
      this._paintLayers()
    }

    const del = document.createElement('button')
    del.className = 'p-mini p-i'
    del.textContent = 'x'
    del.title = 'delete'
    del.onclick = (ev) => {
      ev.stopPropagation()
      // removeAt, not select-then-delete: deleting a row is not a reason to
      // throw away what the user was working on, and the editor re-resolves the
      // live selection across the edit itself.
      this.editor.removeAt(it.kind, it.id, it.index)
      this.syncSelection()
    }

    row.append(id, sum, eye, del)
    return row
  }

  _syncUndo() {
    // canUndo, not history.canUndo: the sculpt tool has its own stack and a
    // greyed-out button over a stack with strokes in it reads as "sculpting
    // cannot be undone", which was the first thing anyone asked.
    this._undoBtn.disabled = !this.editor.canUndo
    this._redoBtn.disabled = !this.editor.history.canRedo
  }
}
