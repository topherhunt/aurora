import { TRI_BUDGET, CALL_BUDGET } from '../../budget.js'
import { TOOLS, TOOL_KEYS } from '../edit/editor.js'
import { RELIEF_KNOBS, RELIEF_DEFAULTS, normalizeRelief } from '../height/relief.js'

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
// THE RELIEF ZONE IS BUILT BY ITERATING RELIEF_KNOBS, never from a list kept in
// here. It is an ablation tool -- switch one term on, look at the mountain,
// switch it off -- and a term that exists in the height field but was forgotten
// in this file is a term nobody ever looks at, which is the whole reason the
// knob table lives in src/v2/height/relief.js and not next to the buttons.
// Every commit hands the host the COMPLETE frozen relief object rather than a
// delta, for the reason relief.js's header gives at length: the main thread and
// every terrain worker have to end up evaluating the same expression, and a
// partial update is how one of them quietly does not.
//
// REPAINT IS 4 Hz, driven by the host calling `setStats`. Same reasoning as
// `Hud.paint`: the numbers are unreadable faster than that and innerHTML is not
// free. The context fields are NOT rebuilt on that clock -- they hold focus and
// a half-typed number -- they are refreshed in place and rebuilt only when the
// selection changes.
//
// `setStats` takes a flat object; the host fills what it can and anything
// missing prints as `??` in the warn colour rather than as a plausible zero:
//   { fps, ms, tris, calls, resident, drawn, terrainTris, queued,
//     triDeg, profileDeg, treeCount,
//     treeTris, grassCount, grassHidden, grassTris, fernCount, fernTris,
//     mushroomCount, mushroomTris, deadwoodCount, deadwoodTris,
//     rockCount, rockTris, litterCount, litterTris,
//     x, y, z, ground, cell, cursorDist, cursorLabel, cursorVariant,
//     snowHere, snowBase, mode, eyeToWater }
// `cell` is the sampling spacing of the chunk she is standing on -- the "am I
// actually seeing 10 cm" readout. The three `cursor*` fields share the one row
// that gets a line of its own: `cursorDist` is metres from the eye to the GROUND
// under the mouse, while `cursorLabel`/`cursorVariant` name the prop in front of
// that ground, or are null where there is none.
// ---------------------------------------------------------------------------

const COLORS = {
  head: '#7fd1ff', // '##'
  bad: '#ff9a7a', // '!!'
  good: '#9dffb0', // '++'
  meas: '#ff5f52', // '%%'
  body: '#cfe3ff',
  dim: '#7f95b4',
}

// x/y/z in the axis colours every 3D tool uses, lightened until they are legible
// on this background -- pure #f00 on #0b1220 is a smear rather than a colour.
// Blue is pushed well past the head blue so `z=` cannot be mistaken for a label.
const AXIS = { x: '#ff8f8f', y: '#9dffb0', z: '#8fbcff' }

// Same one line as src/hud.js. Ids come out of a document that may have been
// imported from a file, so every interpolated string goes through it.
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const num = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : null)

// A scrubbed relief value is `start + n * step` in binary floating point, and a
// 0.05 step reaches 0.30000000000000004 after six ticks. That is the true value
// and the field is right to hold it, but seventeen digits in a 5em box reads as
// a broken widget, so what goes back INTO the input is rounded to four places.
// Only the display: what was committed is what the host was handed.
const knobText = (v) => String(Number(v.toFixed(4)))

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
/* What the cursor is on, riding alongside the range it shares a row with.
   Deliberately quieter and smaller than the range: the range is watched
   continuously while tuning band tables, the name is read once when something
   needs reporting, and the row must not start looking like two headline
   numbers. */
#v2-panel .p-obj { color: ${COLORS.dim}; font-size: 10px; margin-right: 6px; }
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
/* A knob whose parent term is off. Dimmed, NOT disabled: talus is read only
   while erode runs, but setting the repose angle before switching erosion on
   saves a second remesh, and a disabled box would forbid that. */
#v2-panel .p-dim { opacity: .45; }
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

/* The hotkey list is on <body> for the same reason as the menu, plus one: the
   panel body is 34vh with its own scrollbar, and the full key table is taller
   than that. It sits beside the panel rather than over it, so a key can be read
   while the readout it moves is still on screen. */
#v2-keys {
  position: fixed; z-index: 40; top: 0; left: 341px; width: 430px; max-height: 96vh; overflow-y: auto;
  padding: 4px 8px 8px;
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: ${COLORS.body};
  background: rgba(8,14,26,.96); border: 1px solid #2b4a72; border-radius: 3px;
  box-shadow: 0 2px 10px rgba(0,0,0,.5); user-select: none;
}
#v2-keys[hidden] { display: none; }
#v2-keys .k-h { color: ${COLORS.head}; padding-bottom: 2px; border-bottom: 1px solid #1e3253; }
#v2-keys .k-t { color: ${COLORS.dim}; margin: 6px 0 2px; }
#v2-keys .k-g { display: grid; grid-template-columns: 11em 1fr; gap: 1px 8px; }
#v2-keys .k-k { color: ${COLORS.head}; }
`

export class Panel {
  constructor({ layers, editor, relief, hotkeys, onTool, onAction, onRelief }) {
    if (typeof onTool !== 'function') throw new Error('Panel: onTool(name) is required')
    if (typeof onAction !== 'function') throw new Error('Panel: onAction(name) is required')
    // Same throw as the other two, and for a sharper reason: without a host
    // listening, every relief widget below still lights up and still changes
    // its own value, and the terrain does not move. A control that looks like
    // it worked is worse than one that is missing.
    if (typeof onRelief !== 'function') throw new Error('Panel: onRelief(relief) is required')
    // The host's key table (HOTKEYS in main.js). Thrown on rather than defaulted
    // to an empty list: an empty popup is indistinguishable from a panel whose
    // wiring was dropped, and the button would still open and still say nothing.
    if (!Array.isArray(hotkeys) || hotkeys.length === 0) {
      throw new Error('Panel: hotkeys must be the host key table, [{group, rows: [{keys, what}]}]')
    }
    this.hotkeys = hotkeys
    this.layers = layers
    this.editor = editor
    this.onTool = onTool
    this.onAction = onAction
    this.onRelief = onRelief
    // normalizeRelief(undefined) is RELIEF_DEFAULTS, so an omitted `relief` is
    // an all-off world rather than a crash -- and a relief that came from
    // localStorage two schema versions ago is clamped, or throws on a knob that
    // no longer exists, here at construction rather than inside a worker.
    this.relief = normalizeRelief(relief)

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
    // Every layer group starts folded, so the list zone opens as four one-line headers with their counts rather than as a wall of rows. Clicks are remembered here for the session; nothing persists across a reload.
    this._openGroups = new Set()

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

  /**
   * Point the relief widgets at a value the panel did not produce -- the one
   * restored from localStorage at boot, or one the host changed by some other
   * route -- WITHOUT calling `onRelief`.
   *
   * The missing callback is the entire point. Echoing back a value the host
   * just told us about is how a HUD and its host ping-pong: host sets, panel
   * fires, host sets again, and every leg of it remeshes the world. The panel
   * is the source of truth for nothing here; it only ever displays.
   */
  setRelief(relief) {
    this.relief = normalizeRelief(relief)
    this._syncRelief()
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
    // In the mode row and not the footer: the footer is what the DOCUMENT can be
    // done to (save, undo, export) and this is not a document action. It is
    // built exactly like the buttons beside it -- same class, same flow -- and
    // carries no <small> hint because, unlike every tool here, nothing opens it
    // from the keyboard. `_paintTools` indexes `_toolBtns`, not this row's
    // children, so an extra button in the flow cannot desynchronise it.
    this._keysBtn = document.createElement('button')
    this._keysBtn.className = 'p-btn p-i'
    this._keysBtn.textContent = 'hotkeys'
    this._keysBtn.title = 'every key /v2 binds'
    this._keysBtn.onclick = () => this.toggleHotkeys()
    this._tools.appendChild(this._keysBtn)
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

    this._reliefZone = document.createElement('div')
    this._reliefZone.className = 'p-z'
    this._reliefBtns = [] // {knob, btn}
    this._reliefRows = [] // {knob, parent, labelEl, input}
    this._buildRelief()

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

    // Relief sits below the layer list and above the document buttons: it is
    // world-shaped rather than selection-shaped, so it does not belong up with
    // the tools, and it must not be the thing that pushes `save`/`undo` off the
    // bottom of a 34vh body when four groups of layers are expanded.
    this._body.append(this._status, tools, this._ctx, this._layersZone, this._reliefZone, foot, this._err)
    this.root.append(this._head, this._body)

    this._menu = document.createElement('div')
    this._menu.id = 'v2-menu'
    this._menu.hidden = true
    document.body.appendChild(this._menu)

    this._keys = document.createElement('div')
    this._keys.id = 'v2-keys'
    this._keys.hidden = true
    // Built once. The table is a constant of the build, so a rebuild per open
    // would only be a way for the two to drift.
    this._buildHotkeys()
    document.body.appendChild(this._keys)

    // Capture phase, so the press that dismisses the menu is also the press that
    // does whatever it was going to do in the viewport. A menu you have to close
    // before you can click anything is a modal, and this is not one. The hotkey
    // list dismisses the same way, except over its own button: that click is a
    // toggle, and closing here first would close and immediately reopen.
    window.addEventListener('pointerdown', (ev) => {
      if (!this._menu.hidden && !this._menu.contains(ev.target)) this.hideMenu()
      if (!this._keys.hidden && !this._keys.contains(ev.target) && !this._keysBtn.contains(ev.target)) {
        this.hideHotkeys()
      }
    }, true)
    window.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return
      this.hideMenu()
      this.hideHotkeys()
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

  // --- the hotkey list ------------------------------------------------------

  /**
   * Render the host's key table. The panel decides nothing about what is in it:
   * which keys exist is main.js's answer, for the reason its HOTKEYS banner
   * gives, and a malformed row throws here rather than printing `undefined` at
   * someone looking for a key they have not found.
   */
  _buildHotkeys() {
    const html = ['<div class="k-h">hotkeys</div>']
    for (const group of this.hotkeys) {
      if (typeof group.group !== 'string' || !Array.isArray(group.rows)) {
        throw new Error('Panel: each hotkey group must be {group, rows: [{keys, what}]}')
      }
      html.push(`<div class="k-t">${escapeHtml(group.group)}</div><div class="k-g">`)
      for (const row of group.rows) {
        if (typeof row.keys !== 'string' || typeof row.what !== 'string') {
          throw new Error(`Panel: hotkey row in '${group.group}' needs a keys and a what string`)
        }
        html.push(`<span class="k-k">${escapeHtml(row.keys)}</span><span>${escapeHtml(row.what)}</span>`)
      }
      html.push('</div>')
    }
    this._keys.innerHTML = html.join('')
  }

  toggleHotkeys() {
    if (this._keys.hidden) {
      this._keys.hidden = false
      this._keysBtn.classList.add('p-on')
    } else {
      this.hideHotkeys()
    }
  }

  hideHotkeys() {
    this._keys.hidden = true
    this._keysBtn.classList.remove('p-on')
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
    // Resident chunks / drawn chunks / the triangles those drawn chunks cost.
    // The third number is the one the LOD knobs move and it was missing: `tris`
    // above is the whole frame, and every OTHER layer on this row prints its own
    // share, so terrain was the only thing whose cost had to be inferred by
    // subtraction. It is drawnTris, not tris -- the eye-cone subset, matching
    // what the prop rows count and what the budget is actually spent on.
    kv('terrain', Number.isFinite(s.resident) && Number.isFinite(s.terrainTris) ? `${s.resident}/${s.drawn} ${(s.terrainTris / 1000).toFixed(0)}k` : null)
    kv('queued', Number.isFinite(s.queued) ? String(s.queued) : null, s.queued > 64 ? 'c-bad' : '')
    // Two targets on one row because they are read against each other -- the
    // profile figure means nothing except as a ratio to the default beside it,
    // and the gap between them IS how many depth levels a silhouette is worth.
    // "off" rather than a blank when K has turned the term off, so the A/B has a
    // legible state on both sides of the keypress. See terrain/skyline.js.
    kv('triDeg', num(s.triDeg, 2) === null ? null : `${num(s.triDeg, 2)}/${Number.isFinite(s.profileDeg) ? s.profileDeg.toFixed(2) : 'off'}`)
    // The three prop layers get a row each: count, then what that count is
    // actually costing in triangles. DESIGN.md §5 allots trees 37k, and grass
    // is the layer whose row moves most: the region bed is 3/m^2 of scattered
    // strips and lands around 17k, but the same meadow drawn as 3-card clumps
    // (M toggles it) is 53k, and that swing alone is enough to send `tris`
    // above red. Grass shows drawn/resident, because the two differ: the rim
    // (render/rim.js) sets the instances past their trigger distance invisible
    // without releasing them, so a bare resident count would overstate what the
    // triangle figure beside it is counting.
    kv('trees', Number.isFinite(s.treeCount) ? `${s.treeCount} ${(s.treeTris / 1000).toFixed(0)}k` : null)
    kv('grass', Number.isFinite(s.grassCount)
      ? `${s.grassCount - s.grassHidden}/${s.grassCount} ${(s.grassTris / 1000).toFixed(0)}k`
      : null)
    kv('ferns', Number.isFinite(s.fernCount) ? `${s.fernCount} ${(s.fernTris / 1000).toFixed(0)}k` : null)
    // ONE DECIMAL on this row alone, and it is not an inconsistency. Every other
    // prop layer costs tens of thousands of triangles, where a whole `k` is the
    // smallest step worth reading; the mushrooms cost a few hundred to a few
    // thousand, so the neighbours' toFixed(0) would print a flat `0k` almost
    // every frame and the row would say nothing. Keeping the `k` suffix rather
    // than switching to a raw count keeps the column reading as one scale.
    kv('mushrooms', Number.isFinite(s.mushroomCount) ? `${s.mushroomCount} ${(s.mushroomTris / 1000).toFixed(1)}k` : null)
    // Deadfall: logs and rotten stumps. One decimal for the mushrooms' reason,
    // and more so -- this is the cheapest scatter in the world at a few hundred
    // triangles, so a toFixed(0) here would print `0k` and never move.
    kv('deadwood', Number.isFinite(s.deadwoodCount) ? `${s.deadwoodCount} ${(s.deadwoodTris / 1000).toFixed(1)}k` : null)
    // All three rock beds summed. They reach 55 m, 460 m and 1250 m, so the
    // count moves with the terrain rather than with the player's speed.
    kv('rocks', Number.isFinite(s.rockCount) ? `${s.rockCount} ${(s.rockTris / 1000).toFixed(0)}k` : null)
    // The strewn-pebble stamps, which are the row worth watching next to the
    // rocks': two triangles each, so a count that dwarfs the rock count while
    // the tris column stays tiny is the trade working. Reaches 64 m only.
    kv('litter', Number.isFinite(s.litterCount) ? `${s.litterCount} ${(s.litterTris / 1000).toFixed(1)}k` : null)
    kv('mode', s.mode ? String(s.mode) : null, 'c-head')
    // Signed metres from the eye to the water standing over it, blank on dry
    // ground. Two decimals, because the thing it exists to settle -- does the
    // murk switch AT the waterline -- is argued in centimetres, and a row
    // rounded to 0.1 m cannot answer it. Sign is the reading: this and `mode`
    // must change together, and a `mode` of `under` alongside a positive number
    // here is the whole bug, on one screen.
    kv('eye-water', Number.isFinite(s.eyeToWater) ? `${s.eyeToWater >= 0 ? '+' : ''}${s.eyeToWater.toFixed(2)}` : null)
    kv('ground', num(s.ground, 1))
    kv('snow', Number.isFinite(s.snowHere) ? `${s.snowHere.toFixed(0)} (${s.snowBase.toFixed(0)})` : null)
    // The sampling spacing of the chunk she is STANDING on, and §18's "down to
    // 10 cm" is a claim about this exact value -- which makes this the only live
    // check on it, and the reason it is still here at all. It held the big row
    // below until it was pointed out that "50 cm" answers a question about the
    // mesher rather than about the view: true, load-bearing, and of no use to
    // anyone standing in the world. So it keeps its measurement and loses its
    // billing.
    //
    // "underfoot" and not "under cursor", which is what this said while it was
    // showing terrain.stats.finestCell -- the finest chunk ANYWHERE on screen,
    // which is pinned at the depth cap by whatever the camera is nearest to and
    // therefore read 6.3 cm in every situation anyone ever looked at it in. It
    // now reads terrain.stats.cellUnderfoot and it moves.
    kv(
      'cell underfoot',
      Number.isFinite(s.cell) ? (s.cell < 1 ? `${(s.cell * 100).toFixed(1)} cm` : `${s.cell.toFixed(2)} m`) : null
    )

    // THREE COORDINATES ARE THREE NUMBERS AND THE EYE CANNOT TELL WHICH IS
    // WHICH. `311.5 527.4 936.8` has to be counted along every time it is read,
    // and the middle one -- the only one that is not a map coordinate -- is the
    // easiest to mistake for one. So each is named and each is coloured, and the
    // colours are the axis colours every 3D tool uses: x red, y green, z blue.
    // Pulled off the panel's own palette rather than pure rgb, which is
    // unreadable on this background.
    const axis = (k, v, col) =>
      `<span class="p-k" style="color:${col}">${k}=</span>` +
      `<span style="color:${col}">${escapeHtml(v.toFixed(1))}</span>`
    const posOk = Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z)
    cells.push(
      `<span class="p-wide"><span class="p-k">pos </span>${
        posOk
          ? `${axis('x', s.x, AXIS.x)} ${axis('y', s.y, AXIS.y)} ${axis('z', s.z, AXIS.z)}`
          : '<span class="c-bad">??</span>'
      }</span>`
    )

    // WHAT IS THE THING I AM POINTING AT, AND HOW FAR. The big row used to hold
    // the terrain's sampling spacing underfoot, which is a number this world
    // exists to make true and a number nobody standing in the world has any use
    // for -- "50 cm" answers a question about the mesher, not about the view. It
    // is still measured, one row down among the counters, because §18's "down to
    // 10 cm" is a claim about that value and this is the only live check on it.
    //
    // The prominent slot goes to range instead, which is the readout that makes
    // every OTHER number here legible: the band tables in rocks.js and trees.js
    // are all written in metres, so "is that ridge inside 40 m" is the question
    // being asked over and over while any of this is being tuned, and until now
    // it was being answered by walking towards things.
    //
    // THE RANGE IS GROUND ONLY -- see cursorPick in main.js. Point at a tree and
    // the number is the ground behind it, which is why the row also carries the
    // NAME of whatever prop is in front of that ground. The two answer different
    // halves of the same question and the name is the half that can be quoted:
    // "tree 11 is too tall" names a bank entry, and a bank entry can be edited.
    const dist =
      s.cursorDist === null || s.cursorDist === undefined || !Number.isFinite(s.cursorDist)
        ? '--'
        : s.cursorDist < 10
          ? `${s.cursorDist.toFixed(2)} m`
          : `${s.cursorDist.toFixed(1)} m`
    // Blank rather than a placeholder when the ray finds no prop: an empty patch
    // of ground is the common case, and a '--' sitting there permanently would
    // read as a readout that is broken rather than one with nothing to say.
    const obj = s.cursorLabel ? `${s.cursorLabel} ${s.cursorVariant}` : ''
    cells.push(
      `<span class="p-cell"><span class="p-k">cursor:</span>` +
      `<span><span class="p-obj">${escapeHtml(obj)}</span><b>${escapeHtml(dist)}</b></span></span>`
    )

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

  // --- zone 4: relief -------------------------------------------------------

  /**
   * Built ONCE, from RELIEF_KNOBS, and never rebuilt -- `_syncRelief` pushes
   * values into the widgets that already exist. A zone that rebuilt itself on
   * every change would destroy the label mid-drag, and the pointer capture
   * `_attachScrub` took goes with the element: the scrub would die one tick
   * after it started, which is exactly what these knobs are here to be scrubbed
   * through.
   *
   * Two shapes of widget, because the knobs are two kinds of thing. A term you
   * are ablating wants a button -- on, look, off -- and a term that only makes
   * sense inside another one (`aniso` inside `crag`, `talus` inside `erode`)
   * wants a number, since `talus`'s "off" is 55 degrees -- the same angle as its
   * "on" -- and a button offering to toggle 55 to 55 means nothing. Every knob
   * gets the number as well, so a term that reads well at 12 m of crease can be
   * walked down to 9 without leaving the panel.
   */
  _buildRelief() {
    const title = document.createElement('div')
    title.className = 'p-t'
    title.textContent = 'relief'

    // Stated in the panel because the cost is invisible from the outside: every
    // other knob here is a few instructions inside the noise loop and rebuilds
    // in 55-65 ms, and `erode` runs a talus relaxation over a 1024^2 field on
    // three threads first, which measures about 190 ms on top of the 55 and so
    // holds the first chunk back by a rebuild of about 240 ms. Without this line
    // the first thing anyone does is click it twice, assuming a dead button.
    const caution = document.createElement('div')
    caution.className = 'p-k'
    caution.textContent = 'erode: talus relaxation over 1024^2 on 3 threads, ~190 ms per toggle'

    const flow = document.createElement('div')
    flow.className = 'p-flow'
    for (const knob of RELIEF_KNOBS) {
      // The dependent knobs are values, not switches -- see the class comment.
      if (knob.needs !== undefined) continue
      const b = document.createElement('button')
      // p-i or nothing happens. The panel root is `pointer-events: none` so the
      // canvas underneath keeps mouse-look, and a widget that forgets the class
      // does not refuse the click, it never receives it -- no error, no hover,
      // no way to tell from the outside that the wiring is fine.
      b.className = 'p-btn p-i'
      // The `on` value in the <small>, where the tool row puts its hotkey: the
      // useful thing to know before pressing an ablation button is how hard it
      // is about to push, and `crag 12` says twelve metres of crease.
      b.innerHTML = `${escapeHtml(knob.label)}<small>${escapeHtml(knobText(knob.on))}</small>`
      b.title = knob.hint
      b.onclick = () => {
        // Toggles against `off`, not against `on`: a knob scrubbed to 4 is on,
        // and the button has to switch it off rather than jump it to 9 first.
        const next = this.relief[knob.key] === knob.off ? knob.on : knob.off
        this._commitRelief({ ...this.relief, [knob.key]: next })
      }
      this._reliefBtns.push({ knob, btn: b })
      flow.appendChild(b)
    }

    const allOff = document.createElement('button')
    allOff.className = 'p-btn p-i'
    allOff.textContent = 'all off'
    // RELIEF_DEFAULTS, not a loop over the buttons: `talus` has no button and
    // its off is 55, so anything that reset "what the buttons show" would leave
    // it wherever it was and the world would not be the one relief.js's gate
    // asserts is bit-identical.
    allOff.title = 'back to RELIEF_DEFAULTS -- the world exactly as it is with no relief at all'
    allOff.onclick = () => this._commitRelief(RELIEF_DEFAULTS)
    flow.appendChild(allOff)

    const fields = document.createElement('div')
    fields.className = 'p-fields'
    for (const knob of RELIEF_KNOBS) {
      let parent = null
      if (knob.needs !== undefined) {
        parent = RELIEF_KNOBS.find((k) => k.key === knob.needs)
        // A `needs` pointing at a key that is not in the table would dim this
        // row against `undefined` forever, which looks like a disabled widget
        // and reads as a bug in the panel. It is a bug in the knob table.
        if (parent === undefined) throw new Error(`Panel: relief knob '${knob.key}' needs '${knob.needs}', which is not a knob`)
      }

      const input = document.createElement('input')
      input.type = 'number'
      input.className = 'p-num p-i'
      input.step = String(knob.step)
      input.title = knob.hint
      // No min/max attribute, same as the context fields above: the range is a
      // guess and typing past it is how you learn the guess was wrong.
      // normalizeRelief clamps on the way through, so nothing invalid reaches
      // the field either way.
      input.onchange = () => {
        const v = parseFloat(input.value)
        // An emptied or half-typed box would otherwise sit there showing a
        // value the world does not have. Put the live one back.
        if (!Number.isFinite(v)) {
          this._syncRelief()
          return
        }
        this._commitRelief({ ...this.relief, [knob.key]: v })
      }
      input.onkeydown = (ev) => {
        // Without this, typing `1` into the crag box arms the snowline tool and
        // `h` folds the panel away around the number being edited. The window's
        // H handler also ignores events whose target is an input, so this is the
        // belt to that braces.
        ev.stopPropagation()
        if (ev.key === 'Enter') input.blur()
      }

      const k = document.createElement('div')
      k.className = 'p-k p-i p-scrub'
      k.textContent = knob.label
      k.title = `${knob.hint} -- drag left/right to scrub`

      // The row shape _attachScrub expects: step/min/max for the tick size and
      // the clamp, and set(v, commit). `commit` is the undo-push flag for
      // document rows and there is nothing to push here -- relief is not in the
      // document and has no history -- so both the tick and the release commit
      // for real. That is deliberate: watching the ridge line move under the
      // drag is the entire reason these are scrubbable rather than typed.
      //
      // It is also expensive. Every tick is a full world remesh, so `erode`
      // scrubs about as well as it toggles, i.e. badly. That is what its button
      // is for, and why the ranges here are small enough that a 4 px tick is a
      // real change rather than one of sixty on the way to somewhere.
      const row = {
        step: knob.step,
        min: knob.min,
        max: knob.max,
        set: (v) => this._commitRelief({ ...this.relief, [knob.key]: v }),
      }
      this._attachScrub(k, row, input)

      fields.append(k, input)
      this._reliefRows.push({ knob, parent, labelEl: k, input })
    }

    this._reliefZone.append(title, caution, flow, fields)
    this._syncRelief()
  }

  /** Push `this.relief` into the widgets. No callback: see setRelief. */
  _syncRelief() {
    for (const { knob, btn } of this._reliefBtns) {
      // Lit whenever the term does something, not only at exactly `on` -- a
      // knob scrubbed to 4 is affecting the terrain and an unlit button over a
      // changed world is a lie about which terms are in play.
      btn.classList.toggle('p-on', this.relief[knob.key] !== knob.off)
    }
    for (const { knob, parent, labelEl, input } of this._reliefRows) {
      // Never while it has focus: the 4 Hz clock does not drive this zone, but
      // a scrub of one knob syncs all of them, and rewriting a box someone is
      // typing into eats the digits. Same rule as _refreshFields.
      if (document.activeElement !== input) input.value = knobText(this.relief[knob.key])
      if (parent === null) continue
      const inert = this.relief[parent.key] === parent.off
      labelEl.classList.toggle('p-dim', inert)
      input.classList.toggle('p-dim', inert)
    }
  }

  /**
   * The one path by which this panel changes the relief. Normalizes first --
   * clamping and integer rounding happen before anything is displayed, so the
   * number in the box is the number the field will use and not a rounder one
   * the host quietly corrected.
   */
  _commitRelief(next) {
    this.relief = normalizeRelief(next)
    this._syncRelief()
    // The COMPLETE object, never a delta. relief.js's header has the long
    // version: this value has to reach the main thread and every terrain worker
    // identically or she walks on a surface she is not standing on.
    this.onRelief(this.relief)
  }

  _syncUndo() {
    // canUndo, not history.canUndo: the sculpt tool has its own stack and a
    // greyed-out button over a stack with strokes in it reads as "sculpting
    // cannot be undone", which was the first thing anyone asked.
    this._undoBtn.disabled = !this.editor.canUndo
    this._redoBtn.disabled = !this.editor.history.canRedo
  }
}
