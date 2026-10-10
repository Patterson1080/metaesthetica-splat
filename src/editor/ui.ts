import { annotationCss } from '../core/annotations'
import { parseScene, type SplatScene, type Vec3Tuple } from '../core/scene'
import { SplatPlayer } from '../player/index'
import { button, field, h, icons, number, section, setValue, trim } from './dom'
import type { Editor, Tool, Transform } from './editor'
import { download } from './ply-export'
import { buildScenePanels } from './scene-panels'

const SAMPLE_URL = `${import.meta.env.BASE_URL}samples/knot.ply`

const tools: { id: Tool; label: string; key: string; icon: string; hint: string; group: number }[] = [
  { id: 'navigate', label: 'Navigate', key: 'V', icon: icons.navigate, group: 0, hint: 'Drag to orbit · right-drag or Shift-drag to pan · scroll to zoom · F frames the splat' },
  { id: 'rect', label: 'Rectangle select', key: 'R', icon: icons.rect, group: 1, hint: 'Drag a box to select · Shift adds · Ctrl removes · right-drag orbits · Delete removes the selection' },
  { id: 'lasso', label: 'Lasso select', key: 'L', icon: icons.lasso, group: 1, hint: 'Draw around splats to select · Shift adds · Ctrl removes · right-drag orbits' },
  { id: 'brush', label: 'Brush select', key: 'B', icon: icons.brush, group: 1, hint: 'Paint over splats to select · [ and ] resize the brush · Shift adds · Ctrl removes · right-drag orbits' },
  { id: 'move', label: 'Move', key: '1', icon: icons.move, group: 2, hint: 'Drag a handle to move the splat · drag empty space to orbit' },
  { id: 'rotate', label: 'Rotate', key: '2', icon: icons.rotate, group: 2, hint: 'Drag a ring to rotate the splat · drag empty space to orbit' },
  { id: 'scale', label: 'Scale', key: '3', icon: icons.scale, group: 2, hint: 'Drag a handle to scale the splat (the center cube scales evenly)' },
  { id: 'annotate', label: 'Label', key: 'A', icon: icons.label, group: 3, hint: 'Click the splat to pin a label · drag its text to move it · drag its dot to re-pin · drag empty space to orbit' },
]

const AXES = ['X', 'Y', 'Z'] as const

/** Build the editor's DOM. The canvases must exist before the engine can be created. */
export function buildShell(root: HTMLElement) {
  const canvas = h('canvas', { class: 'scene', tabIndex: 0, attrs: { 'aria-label': '3D viewport' } })
  const overlay = h('canvas', { class: 'overlay' })
  const empty = h('div', { class: 'empty' })
  const busy = h('div', { class: 'busy', hidden: true })
  const viewport = h('main', { class: 'viewport' }, canvas, overlay, empty, busy)
  const topbar = h('header', { class: 'topbar' })
  const rail = h('nav', { class: 'rail', attrs: { 'aria-label': 'Tools' } })
  const panel = h('aside', { class: 'panel' })
  const status = h('footer', { class: 'status' })
  root.append(topbar, rail, viewport, panel, status)
  return { canvas, overlay, empty, busy, viewport, topbar, rail, panel, status }
}

type Shell = ReturnType<typeof buildShell>

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

export function bindUi(shell: Shell, editor: Editor) {
  const { viewer } = editor
  const fileInput = h('input', { type: 'file', accept: '.ply,.sog,.json', multiple: true, hidden: true })
  document.body.append(fileInput)

  // ── opening files ────────────────────────────────────────────────────────

  const report = (error: unknown) => {
    console.error(error)
    notice(`Could not open the file: ${error instanceof Error ? error.message : String(error)}`, true)
  }

  async function openFiles(files: File[]) {
    const splat = files.find((f) => /\.(ply|sog)$/i.test(f.name))
    const sceneFile = files.find((f) => /\.json$/i.test(f.name))
    let scene: SplatScene | undefined
    if (sceneFile) {
      try {
        scene = parseScene(JSON.parse(await sceneFile.text()))
      } catch (error) {
        return report(error)
      }
    }
    if (!splat) {
      return notice(sceneFile ? 'Drop the scene file together with its splat file (.ply or .sog)' : 'Not a splat file. Use .ply, .compressed.ply or .sog', true)
    }
    await editor.open({ file: splat }, scene).catch(report)
  }

  fileInput.addEventListener('change', () => {
    void openFiles([...(fileInput.files ?? [])])
    fileInput.value = ''
  })
  const browse = () => fileInput.click()
  const openSample = () => editor.open({ url: SAMPLE_URL }).catch(report)

  let dragDepth = 0
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    dragDepth++
    document.body.classList.add('dropping')
  })
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) document.body.classList.remove('dropping')
  })
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    dragDepth = 0
    document.body.classList.remove('dropping')
    void openFiles([...(e.dataTransfer?.files ?? [])])
  })

  // ── top bar ──────────────────────────────────────────────────────────────

  const docName = h('span', { class: 'doc-name' })
  const undo = button('Undo', () => editor.history.undo(), { icon: icons.undo })
  const redo = button('Redo', () => editor.history.redo(), { icon: icons.redo })
  const frame = button('Frame splat (F)', () => editor.frame(), { icon: icons.frame })
  const preview = button('Preview', () => void openPreview(), { class: 'primary', title: 'Open the edited scene in the embeddable player' })
  preview.prepend(h('span', { class: 'icon', innerHTML: icons.play }))
  shell.topbar.append(
    h('strong', { class: 'brand' }, 'Splat Engine'),
    docName,
    button('Open…', browse, { title: 'Open a .ply, .compressed.ply or .sog (Ctrl+O)' }),
    button('Sample', () => void openSample(), { title: 'Load the built-in sample splat' }),
    h('span', { class: 'sep' }),
    undo,
    redo,
    frame,
    h('span', { class: 'spacer' }),
    preview,
  )

  // ── tool rail ────────────────────────────────────────────────────────────

  const toolButtons = new Map<Tool, HTMLButtonElement>()
  tools.forEach((tool, i) => {
    if (i > 0 && tools[i - 1].group !== tool.group) shell.rail.append(h('span', { class: 'sep' }))
    const node = button(tool.label, () => editor.setTool(tool.id), { icon: tool.icon, title: `${tool.label} (${tool.key})` })
    toolButtons.set(tool.id, node)
    shell.rail.append(node)
  })

  // ── empty state ──────────────────────────────────────────────────────────

  shell.empty.append(
    h('div', { class: 'drop' },
      h('p', { class: 'lead' }, 'Drop a Gaussian splat here'),
      h('p', {}, '.ply · .compressed.ply · .sog'),
      h('div', { class: 'row' }, button('Browse…', browse, { class: 'primary' }), button('Load sample', () => void openSample())),
      h('p', { class: 'fine' }, 'To reopen an exported scene, drop its .json together with the splat file.'),
    ),
  )

  // ── status bar ───────────────────────────────────────────────────────────

  const message = h('span', { class: 'message' })
  const counts = h('span', { class: 'counts' })
  shell.status.append(message, h('span', { class: 'spacer' }), counts, h('span', { class: 'gpu' }, viewer.isWebGPU ? 'WebGPU' : 'WebGL 2'))
  let noticeTimer = 0
  const showHint = () => {
    message.classList.remove('error')
    let hint = editor.doc ? (tools.find((t) => t.id === editor.tool)?.hint ?? '') : 'Open a splat to begin'
    // the gizmo tools say what they are pointed at, since it is not always the splat
    const { active } = editor
    if (editor.doc && active && ['move', 'rotate', 'scale'].includes(editor.tool)) {
      const item = active.kind === 'section' ? editor.settings.sections[active.index] : editor.settings.forces[active.index]
      const what = active.kind === 'section' ? 'section box' : 'force'
      hint = `Editing ${what} “${item?.name || what}”: drag a handle to ${editor.tool} it · Esc returns the tools to the splat`
    }
    message.textContent = hint
  }
  function notice(text: string, error = false) {
    message.textContent = text
    message.classList.toggle('error', error)
    clearTimeout(noticeTimer)
    noticeTimer = window.setTimeout(showHint, error ? 8000 : 4000)
  }

  // ── panel: selection ─────────────────────────────────────────────────────

  const stats = h('dl', { class: 'stats' })
  const selectionButtons = {
    all: button('All', () => editor.selectAll(), { title: 'Select all (Ctrl+A)' }),
    none: button('None', () => editor.selectNone(), { title: 'Deselect all (Esc)' }),
    invert: button('Invert', () => editor.invertSelection(), { title: 'Invert selection (Ctrl+I)' }),
    remove: button('Delete', () => editor.deleteSelected(), { class: 'danger', title: 'Delete selected splats (Delete)' }),
    keep: button('Keep only', () => editor.keepSelected(), { title: 'Delete everything except the selection' }),
  }
  const brushSize = h('input', { type: 'range', min: '4', max: '200', step: '1' })
  brushSize.addEventListener('input', () => editor.selection.setBrushRadius(Number(brushSize.value)))
  const syncBrush = () => setValue(brushSize, String(editor.selection.brushRadius))

  const faint = h('input', { type: 'range', min: '0.01', max: '0.6', step: '0.01', value: '0.1' })
  const faintValue = h('output', {})
  const syncFaint = () => (faintValue.textContent = `≤ ${Number(faint.value).toFixed(2)}`)
  faint.addEventListener('input', syncFaint)
  syncFaint()
  const faintButton = button('Select', () => editor.selectFaint(Number(faint.value)))

  const radius = number(() => {}, { step: 0.1, min: 0, title: 'World units from the orbit target' })
  radius.value = '2'
  const radiusButton = button('Select', () => editor.selectOutside(Number(radius.value) || 0))

  const selectSection = section(
    'Selection',
    stats,
    h('div', { class: 'row' }, selectionButtons.all, selectionButtons.none, selectionButtons.invert),
    h('div', { class: 'row' }, selectionButtons.remove, selectionButtons.keep),
    field('Brush size', brushSize),
    h('h3', {}, 'Clean-up'),
    field('Faint splats', faint, faintValue, faintButton),
    field('Beyond radius', radius, radiusButton),
    h('p', { class: 'fine' }, 'Clean-up selects; review the highlight, then press Delete. The radius is measured from the point the camera orbits.'),
  )

  // ── panel: transform ─────────────────────────────────────────────────────

  const transformInputs: Record<keyof Transform, HTMLInputElement[]> = { position: [], rotation: [], scale: [] }
  const transformRow = (key: keyof Transform, label: string, step: number) => {
    const inputs = AXES.map((axis, i) =>
      number(
        (value) => {
          const t = editor.getTransform()
          if (!t) return
          const next = [...t[key]] as Vec3Tuple
          next[i] = value
          editor.setTransform({ ...t, [key]: next })
        },
        { step, title: `${label} ${axis}` },
      ),
    )
    transformInputs[key] = inputs
    return field(label, ...inputs)
  }
  const transformSection = section(
    'Transform',
    transformRow('position', 'Position', 0.1),
    transformRow('rotation', 'Rotation', 5),
    transformRow('scale', 'Scale', 0.1),
    h('div', { class: 'row' },
      button('Flip upright', () => {
        const t = editor.getTransform()
        if (t) editor.setTransform({ ...t, rotation: [t.rotation[0], t.rotation[1], ((t.rotation[2] + 360) % 360) - 180] })
      }, { title: 'Turn the splat half a revolution about Z. Captures are usually stored upside down.' }),
      button('Reset', () => editor.setTransform({ position: [0, 0, 0], rotation: [0, 0, 180], scale: [1, 1, 1] })),
    ),
  )

  // ── panel: camera and views ──────────────────────────────────────────────

  const fov = h('input', { type: 'range', min: '20', max: '100', step: '1' })
  const fovValue = h('output', {})
  fov.addEventListener('input', () => editor.updateSettings({ fov: Number(fov.value) }))
  const startState = h('span', { class: 'fine' })
  const startGo = button('Go', () => editor.settings.initial && editor.goToPose(editor.settings.initial))
  const startClear = button('Clear', () => editor.updateSettings({ initial: null }))
  const poseList = h('ul', { class: 'poses' })
  const cameraSection = section(
    'Camera & views',
    field('Field of view', fov, fovValue),
    h('h3', {}, 'Start view'),
    h('div', { class: 'row' }, button('Set from camera', () => editor.setInitialFromCamera()), startGo, startClear),
    startState,
    h('h3', {}, 'Saved views'),
    poseList,
    h('div', { class: 'row' }, button('+ Add current view', () => editor.addPose())),
  )

  // ── panel: player settings ───────────────────────────────────────────────

  const background = h('input', { type: 'color' })
  const transparent = h('input', { type: 'checkbox' })
  background.addEventListener('input', () => editor.updateSettings({ background: background.value }))
  transparent.addEventListener('change', () => editor.updateSettings({ background: transparent.checked ? null : background.value }))
  const limit = (key: 'minDistance' | 'maxDistance' | 'minPitch' | 'maxPitch' | 'autoRotate', props: Parameters<typeof number>[1]) =>
    number((value) => editor.updateSettings({ controls: { [key]: value } }), props)
  const limits = {
    minDistance: limit('minDistance', { step: 0.1, min: 0, title: 'Closest zoom' }),
    maxDistance: limit('maxDistance', { step: 0.5, min: 0, title: 'Farthest zoom' }),
    minPitch: limit('minPitch', { step: 1, min: -89.5, max: 89.5, title: 'Lowest pitch in degrees. Negative looks down on the scene.' }),
    maxPitch: limit('maxPitch', { step: 1, min: -89.5, max: 89.5, title: 'Highest pitch in degrees. Positive looks up from below.' }),
    autoRotate: limit('autoRotate', { step: 1, title: 'Degrees per second while idle; 0 is off' }),
  }
  const pan = h('input', { type: 'checkbox' })
  pan.addEventListener('change', () => editor.updateSettings({ controls: { pan: pan.checked } }))
  const grid = h('input', { type: 'checkbox', checked: true })
  grid.addEventListener('change', () => editor.setGrid(grid.checked))
  const useDistance = (key: 'minDistance' | 'maxDistance') =>
    button('Use current', () => editor.updateSettings({ controls: { [key]: Number(trim(viewer.controls.distance, 2)) } }), { title: 'Use the camera’s current distance' })
  const playerSection = section(
    'Player',
    field('Background', background, h('label', { class: 'check' }, transparent, 'Transparent')),
    field('Auto-rotate °/s', limits.autoRotate),
    field('Nearest', limits.minDistance, useDistance('minDistance')),
    field('Farthest', limits.maxDistance, useDistance('maxDistance')),
    field('Pitch range', limits.minPitch, limits.maxPitch),
    h('label', { class: 'check' }, pan, 'Viewers may pan'),
    h('h3', {}, 'Editor viewport'),
    h('label', { class: 'check' }, grid, 'Show grid'),
  )

  // ── panel: export ────────────────────────────────────────────────────────

  const exportName = h('input', { type: 'text', spellcheck: false })
  const splatUrl = h('input', { type: 'text', spellcheck: false, title: 'How the scene file refers to the splat, relative to the scene file' })
  const posterRef = h('input', { type: 'checkbox' })
  const baseName = () => exportName.value.trim() || editor.doc?.name || 'splat'
  exportName.addEventListener('input', () => {
    // follow the name until the user points the scene at something else (e.g. a .sog)
    if (splatUrl.dataset.custom !== 'true') splatUrl.value = `${baseName()}.ply`
    sogHint()
  })
  splatUrl.addEventListener('input', () => (splatUrl.dataset.custom = 'true'))

  const run = async (task: () => Promise<void>) => {
    try {
      await task()
    } catch (error) {
      console.error(error)
      notice(`Export failed: ${error instanceof Error ? error.message : String(error)}`, true)
    }
  }
  const buildSceneFile = () => {
    const scene = editor.buildScene(splatUrl.value.trim() || `${baseName()}.ply`)
    if (posterRef.checked) scene.poster = `${baseName()}.webp`
    return scene
  }
  const sogCommand = h('code', {})
  const sogHint = () => (sogCommand.textContent = `npx @playcanvas/splat-transform ${baseName()}.ply ${baseName()}.sog`)
  const exportSection = section(
    'Export',
    field('Name', exportName),
    field('Splat URL in scene', splatUrl),
    h('label', { class: 'check' }, posterRef, 'Scene references the poster'),
    h('div', { class: 'column' },
      button('Download splat (.ply)', () => run(async () => {
        const { blob, count } = await editor.buildPly()
        download(blob, `${baseName()}.ply`)
        notice(`Exported ${count.toLocaleString()} splats to ${baseName()}.ply`)
      })),
      button('Download scene (.json)', () => run(async () => {
        download(new Blob([JSON.stringify(buildSceneFile(), null, 2)], { type: 'application/json' }), `${baseName()}.scene.json`)
        notice(`Exported ${baseName()}.scene.json`)
      })),
      button('Download poster (.webp)', () => run(async () => {
        download(await editor.capturePoster(), `${baseName()}.webp`)
        notice(`Exported ${baseName()}.webp from the current view`)
      })),
    ),
    h('p', { class: 'fine' }, 'For the web, compress the .ply to .sog (about 15–20× smaller), then point “Splat URL in scene” at it:'),
    h('pre', {}, sogCommand),
  )

  const scenePanels = buildScenePanels(editor)
  shell.panel.append(selectSection, transformSection, ...scenePanels.panels, cameraSection, playerSection, exportSection)

  // the callouts in the viewport are the player's own, so they need the player's styles
  document.head.append(h('style', { textContent: annotationCss }))

  // ── preview in the real player ───────────────────────────────────────────

  const previewStage = h('div', { class: 'preview-stage' })
  const previewDialog = h('dialog', { class: 'preview' },
    h('header', {},
      h('strong', {}, 'Player preview'),
      h('span', { class: 'fine' }, 'This is the embeddable player, running the scene as it would be exported.'),
      h('span', { class: 'spacer' }),
      button('Close', () => previewDialog.close(), { icon: icons.close }),
    ),
    previewStage,
  )
  document.body.append(previewDialog)
  let previewPlayer: SplatPlayer | null = null
  let previewUrl: string | null = null
  previewDialog.addEventListener('close', () => {
    previewPlayer?.destroy()
    previewPlayer = null
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    previewUrl = null
  })

  async function openPreview() {
    if (!editor.doc || previewDialog.open) return
    await run(async () => {
      const { blob } = await editor.buildPly()
      previewUrl = URL.createObjectURL(blob)
      const scene = editor.buildScene(previewUrl)
      // a blob: URL has no extension for the player to recognise the format by
      scene.splats[0].filename = 'preview.ply'
      previewDialog.showModal()
      previewPlayer = new SplatPlayer(previewStage, { scene, load: 'eager', interaction: 'always' })
      previewPlayer.on('error', (error) => notice(`Preview failed: ${error.message}`, true))
    })
  }

  // ── keeping the panels in sync ───────────────────────────────────────────

  function syncDoc() {
    const { doc } = editor
    document.body.classList.toggle('has-doc', !!doc)
    shell.empty.hidden = !!doc
    docName.textContent = doc ? doc.splat.filename : ''
    preview.disabled = frame.disabled = !doc
    if (doc) {
      exportName.value = doc.name
      splatUrl.value = `${doc.name}.ply`
      delete splatUrl.dataset.custom
      sogHint()
      const focus = viewer.getFocus()
      if (focus) radius.value = trim(focus.radius * 1.1, 2)
    }
    faintButton.disabled = faint.disabled = !editor.canSelectByOpacity
    faintButton.title = editor.canSelectByOpacity ? '' : 'Needs uncompressed data: open the .ply rather than the .sog'
    showHint()
  }

  function syncSelection() {
    const state = editor.doc?.state
    const row = (label: string, value: number | undefined) => [h('dt', {}, label), h('dd', {}, value === undefined ? '–' : value.toLocaleString())]
    stats.replaceChildren(...row('Splats', state?.remaining), ...row('Selected', state?.selected), ...row('Deleted', state?.deleted))
    counts.textContent = state ? `${state.remaining.toLocaleString()} splats${state.selected ? ` · ${state.selected.toLocaleString()} selected` : ''}` : ''
    const none = !state || state.selected === 0
    selectionButtons.remove.disabled = selectionButtons.keep.disabled = selectionButtons.none.disabled = none
    selectionButtons.all.disabled = selectionButtons.invert.disabled = !state
  }

  function syncTransform() {
    const t = editor.getTransform()
    for (const key of Object.keys(transformInputs) as (keyof Transform)[]) {
      transformInputs[key].forEach((input, i) => {
        input.disabled = !t
        if (t) setValue(input, trim(t[key][i]))
      })
    }
  }

  function syncSettings() {
    const s = editor.settings
    setValue(fov, String(s.fov))
    fovValue.textContent = `${Math.round(s.fov)}°`
    startState.textContent = s.initial ? 'Set. The player opens on this view.' : 'Not set: an export uses wherever the camera is at that moment.'
    startGo.disabled = startClear.disabled = !s.initial

    poseList.replaceChildren(
      ...s.poses.map((pose, i) => {
        const name = h('input', { type: 'text', value: pose.name ?? '', spellcheck: false, attrs: { 'aria-label': `Name of view ${i + 1}` } })
        name.addEventListener('change', () => editor.updatePose(i, { name: name.value.trim() || undefined }))
        return h('li', {},
          name,
          button('Go', () => editor.goToPose(pose), { title: 'Move the camera to this view' }),
          button('Update', () => editor.updatePose(i, 'camera'), { title: 'Replace this view with the current camera' }),
          button('Remove view', () => editor.removePose(i), { icon: icons.close }),
        )
      }),
    )
    if (s.poses.length === 0) poseList.append(h('li', { class: 'fine' }, 'None yet. Viewers step through saved views with the arrows in the player.'))

    transparent.checked = s.background === null
    background.disabled = s.background === null
    if (s.background) setValue(background, s.background)
    for (const key of Object.keys(limits) as (keyof typeof limits)[]) setValue(limits[key], trim(s.controls[key], 2))
    pan.checked = s.controls.pan
    // callouts take their halo from the stage color, as they will in the player
    if (s.background) shell.viewport.style.setProperty('--splat-bg', s.background)
    else shell.viewport.style.removeProperty('--splat-bg')
  }

  function syncTool() {
    for (const [id, node] of toolButtons) node.setAttribute('aria-pressed', String(id === editor.tool))
    shell.viewport.dataset.tool = editor.tool
    showHint()
  }

  function syncHistory() {
    undo.disabled = !editor.history.canUndo
    redo.disabled = !editor.history.canRedo
    undo.title = editor.history.undoLabel ? `Undo ${editor.history.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'
    redo.title = editor.history.redoLabel ? `Redo ${editor.history.redoLabel} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)'
  }

  editor.events.on('doc', syncDoc)
  editor.events.on('selection', syncSelection)
  editor.events.on('transform', syncTransform)
  editor.events.on('settings', syncSettings)
  editor.events.on('scene', () => {
    scenePanels.sync()
    showHint()
  })
  editor.events.on('tool', syncTool)
  editor.events.on('history', syncHistory)
  editor.events.on('notice', (text) => notice(text))
  editor.events.on('busy', (text) => {
    shell.busy.hidden = text === null
    shell.busy.textContent = text ?? ''
  })
  syncDoc()
  syncSelection()
  syncTransform()
  syncSettings()
  scenePanels.sync()
  syncTool()
  syncHistory()
  syncBrush()

  // ── keyboard ─────────────────────────────────────────────────────────────

  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target) || previewDialog.open) return
    const key = e.key.toLowerCase()
    const mod = e.ctrlKey || e.metaKey

    if (mod) {
      if (key === 'z') e.shiftKey ? editor.history.redo() : editor.history.undo()
      else if (key === 'y') editor.history.redo()
      else if (key === 'a') editor.selectAll()
      else if (key === 'i') editor.invertSelection()
      else if (key === 'o') browse()
      else return
      e.preventDefault()
      return
    }
    if (e.altKey) return

    const tool = tools.find((t) => t.key.toLowerCase() === key)
    if (tool) editor.setTool(tool.id)
    else if (key === 'delete' || key === 'backspace') {
      // splats first; with nothing selected, the Label tool's Delete removes the active label
      if (editor.doc?.state.selected) editor.deleteSelected()
      else if (editor.tool === 'annotate' && editor.activeAnnotation !== null) editor.removeAnnotation(editor.activeAnnotation)
    } else if (key === 'escape') {
      // each press backs out of one thing: the selection, then the object being edited, then the tool
      if (editor.doc?.state.selected) editor.selectNone()
      else if (editor.active) editor.setActive(null)
      else if (editor.activeAnnotation !== null) editor.setActiveAnnotation(null)
      else editor.setTool('navigate')
    }
    else if (key === 'f') editor.frame()
    else if (key === '[' || key === ']') {
      editor.selection.setBrushRadius(editor.selection.brushRadius * (key === ']' ? 1.25 : 0.8))
      syncBrush()
    } else return
    e.preventDefault()
  })

  // unsaved edits live only in this tab
  window.addEventListener('beforeunload', (e) => {
    if (editor.history.canUndo) e.preventDefault()
  })

  return { openFiles, openSample, notice }
}
