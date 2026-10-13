import { annotationCss } from '../core/annotations'
import { parseScene, type SplatScene, type Vec3Tuple } from '../core/scene'
import { SplatPlayer } from '../player/index'
import { button, field, group, h, icons, number, setValue, trim, vec3Row } from './dom'
import type { Editor, Tool, Transform } from './editor'
import { createKeyToggles } from './key-toggle'
import { download } from './ply-export'
import { buildScenePanels } from './scene-panels'
import { buildTabs } from './tabs'
import { buildTimeline } from './timeline'
import { buildViewGizmo } from './view-gizmo'

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
  const timeline = h('section', { class: 'timeline', attrs: { 'aria-label': 'Timeline' } })
  const status = h('footer', { class: 'status' })
  root.append(topbar, rail, viewport, panel, timeline, status)
  return { canvas, overlay, empty, busy, viewport, topbar, rail, panel, timeline, status }
}

type Shell = ReturnType<typeof buildShell>

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

export function bindUi(shell: Shell, editor: Editor) {
  const { viewer } = editor
  // the diamond at the end of every property that can be animated
  const keys = createKeyToggles(editor)
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

  const selectionGroup = group(
    'Selection',
    { help: 'Select with the rectangle, lasso or brush tools on the left. Shift adds to the selection, Ctrl removes from it.' },
    stats,
    h('div', { class: 'row' }, selectionButtons.all, selectionButtons.none, selectionButtons.invert),
    h('div', { class: 'row' }, selectionButtons.remove, selectionButtons.keep),
    field('Brush size', brushSize),
  )
  const cleanupGroup = group(
    'Clean-up',
    { help: 'These select; review the highlight, then press Delete. The radius is measured from the point the camera orbits.' },
    field('Faint splats', faint, faintValue, faintButton),
    field('Beyond radius', radius, radiusButton),
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
    const row = field(label, ...inputs)
    keys.attach(row, () => `splat.${key}`)
    return row
  }
  const transformGroup = group(
    'Transform',
    { help: 'Where the splat sits in the scene. Captures usually arrive upside down; Flip upright turns one the right way. Tools 1, 2 and 3 do the same by hand.' },
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
  const fovRow = field('Field of view', fov, fovValue)
  keys.attach(fovRow, () => 'camera.fov')
  const lensGroup = group('Lens', {}, fovRow)
  // where the viewport camera is: the numbers behind what the mouse does
  const cameraRows = {
    position: vec3Row('Position', 0.1, (position) => editor.setViewPose({ position })),
    target: vec3Row('Target', 0.1, (target) => editor.setViewPose({ target })),
  }
  keys.attach(cameraRows.position.node, () => 'camera.position')
  keys.attach(cameraRows.target.node, () => 'camera.target')
  const viewpointGroup = group(
    'Viewpoint',
    { id: 'camera-viewpoint', help: 'Where the viewport camera stands and the point it looks at and orbits. Their diamonds key the camera on the timeline at the playhead, one property at a time; Key camera (Shift+K) keys all three.' },
    cameraRows.position.node,
    cameraRows.target.node,
  )
  const startGroup = group(
    'Start view',
    { help: 'The view the player opens on, and returns to on reset.' },
    h('div', { class: 'row' }, button('Set from camera', () => editor.setInitialFromCamera()), startGo, startClear),
    startState,
  )
  const viewsGroup = group(
    'Saved views',
    { help: 'Named viewpoints. Viewers step through them with the arrows in the player. For a camera that moves on its own, key it on the timeline instead.' },
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
  const stageGroup = group(
    'Stage',
    { help: 'What is behind the splat in the player. Transparent lets the page show through.' },
    field('Background', background, h('label', { class: 'check' }, transparent, 'Transparent')),
  )
  const orbitGroup = group(
    'Orbit limits',
    { help: 'How far viewers may zoom and tilt in the player. They do not bind the editor’s own camera.' },
    field('Nearest', limits.minDistance, useDistance('minDistance')),
    field('Farthest', limits.maxDistance, useDistance('maxDistance')),
    field('Pitch range', limits.minPitch, limits.maxPitch),
    h('label', { class: 'check' }, pan, 'Viewers may pan'),
  )
  const idleGroup = group('Idle motion', { help: 'A slow turn around the splat while nobody is touching it. 0 is off.' }, field('Auto-rotate °/s', limits.autoRotate))
  const viewportGroup = group('Viewport', { closed: true }, h('label', { class: 'check' }, grid, 'Show grid'))

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
  // ── video ──
  const option = (value: string, label: string) => h('option', { value }, label)
  const videoSize = h('select', { title: 'Width × height of the video, in pixels' },
    option('1280x720', '1280 × 720 (HD)'),
    option('1920x1080', '1920 × 1080 (Full HD)'),
    option('2560x1440', '2560 × 1440'),
    option('3840x2160', '3840 × 2160 (4K)'),
    option('1080x1080', '1080 × 1080 (square)'),
    option('1080x1920', '1080 × 1920 (vertical)'),
  )
  videoSize.value = '1920x1080'
  // one frame rate for the timeline and for the video rendered from it
  const videoFps = h('select', { title: 'Frames per second. This is the timeline’s frame rate: changing it here changes it there.' })
  videoFps.addEventListener('change', () => editor.setFps(Number(videoFps.value)))
  const syncVideoFps = () => {
    const rates = [...new Set([24, 25, 30, 50, 60, editor.fps])].sort((a, b) => a - b)
    videoFps.replaceChildren(...rates.map((rate) => option(String(rate), `${trim(rate, 3)} fps`)))
    videoFps.value = String(editor.fps)
  }
  const videoQuality = h('select', {}, option('high', 'High'), option('max', 'Very high (larger file)'))
  let renderAbort: AbortController | null = null
  const renderButton = button('Render video (.mp4)', () => {
    if (renderAbort) return renderAbort.abort()
    void run(async () => {
      const [width, height] = videoSize.value.split('x').map(Number)
      const { fps } = editor
      renderAbort = new AbortController()
      renderButton.textContent = 'Cancel render'
      shell.busy.hidden = false
      try {
        const blob = await editor.renderVideo({
          width,
          height,
          fps,
          quality: videoQuality.value as 'high' | 'max',
          signal: renderAbort.signal,
          onProgress: (fraction) => (shell.busy.textContent = `Rendering video… ${Math.round(fraction * 100)}%`),
        })
        download(blob, `${baseName()}.mp4`)
        const frames = Math.max(1, Math.round(editor.animation.duration * fps))
        notice(`Rendered ${baseName()}.mp4: ${frames} frames (${trim(editor.animation.duration, 2)} s) at ${width}×${height}, ${trim(fps, 3)} fps, ${(blob.size / 1048576).toFixed(1)} MB`)
      } catch (error) {
        // cancelling is not a failure
        if (!(error instanceof DOMException && error.name === 'AbortError')) throw error
        notice('Render cancelled')
      } finally {
        renderAbort = null
        renderButton.textContent = 'Render video (.mp4)'
        shell.busy.hidden = true
      }
    })
  }, { class: 'primary', title: 'Render the timeline from start to end as an H.264 .mp4' })

  const filesGroup = group(
    'Files',
    { help: 'The splat without what you deleted, the scene file the player reads (camera, boxes, labels, forces, animation), and a still of the current view to show before the splat loads.' },
    field('Name', exportName),
    field('Splat URL', splatUrl),
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
  )
  const compressGroup = group(
    'Compress for the web',
    { closed: true, help: 'Run this on the downloaded .ply, then point “Splat URL” above at the .sog. It is typically 15–20× smaller.' },
    h('pre', {}, sogCommand),
  )
  const videoGroup = group(
    'Video',
    { help: 'Renders the whole timeline to an .mp4, frame by frame, through the animated camera (or the current view, if the camera has no keys). Labels are not part of the picture: they are drawn by the page, over the canvas.' },
    field('Size', videoSize),
    field('Frame rate', videoFps),
    field('Quality', videoQuality),
    h('div', { class: 'column' }, renderButton),
  )

  const scenePanels = buildScenePanels(editor, keys)
  const gizmo = buildViewGizmo(shell.viewport, editor)
  const timeline = buildTimeline(shell.timeline, editor)
  // one tab per subject, as in Blender's Properties editor
  const tabs = buildTabs(shell.panel, [
    { id: 'edit', label: 'Edit', title: 'Select & clean up', icon: icons.tabEdit, groups: [selectionGroup, cleanupGroup, viewportGroup] },
    { id: 'splat', label: 'Splat', title: 'Splat', icon: icons.tabSplat, groups: [transformGroup] },
    { id: 'boxes', label: 'Boxes', title: 'Section boxes', icon: icons.tabBoxes, groups: scenePanels.boxes },
    { id: 'forces', label: 'Forces', title: 'Forces', icon: icons.tabForces, groups: scenePanels.forces },
    { id: 'labels', label: 'Labels', title: 'Labels', icon: icons.label, groups: scenePanels.labels },
    { id: 'camera', label: 'Camera', title: 'Camera & views', icon: icons.tabCamera, groups: [viewpointGroup, lensGroup, startGroup, viewsGroup] },
    { id: 'player', label: 'Player', title: 'Player', icon: icons.tabPlayer, groups: [stageGroup, orbitGroup, idleGroup] },
    { id: 'export', label: 'Export', title: 'Export', icon: icons.tabExport, groups: [filesGroup, compressGroup, videoGroup] },
  ])
  const syncBadges = () => {
    tabs.setBadge('boxes', editor.settings.sections.length)
    tabs.setBadge('forces', editor.settings.forces.length)
    tabs.setBadge('labels', editor.settings.annotations.length)
  }

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
    // picking up a tool brings forward the properties that go with it
    if (['rect', 'lasso', 'brush'].includes(editor.tool)) tabs.select('edit')
    else if (editor.tool === 'annotate') tabs.select('labels')
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

  // several events arrive together (a key added is 'scene' and 'animation' at once); the diamonds are brought up to date once
  let keysQueued = false
  const syncKeys = () => {
    if (keysQueued) return
    keysQueued = true
    queueMicrotask(() => {
      keysQueued = false
      keys.sync()
    })
  }
  function syncView() {
    // during playback the panels rest; they catch up when it stops
    if (editor.playing) return
    const pose = viewer.controls.getPose()
    for (const input of [...cameraRows.position.inputs, ...cameraRows.target.inputs]) input.disabled = !editor.doc
    cameraRows.position.set(pose.position)
    cameraRows.target.set(pose.target)
    keys.sync((target) => target.startsWith('camera.'))
  }

  editor.events.on('doc', syncDoc)
  editor.events.on('selection', syncSelection)
  editor.events.on('transform', syncTransform)
  editor.events.on('settings', syncSettings)
  let lastActive: string | null = null
  editor.events.on('scene', () => {
    scenePanels.sync()
    syncBadges()
    showHint()
    // pressing Edit on a box or force (or adding one) brings its properties forward
    const active = editor.active ? `${editor.active.kind}:${editor.active.index}` : null
    if (active && active !== lastActive) tabs.select(editor.active!.kind === 'section' ? 'boxes' : 'forces')
    lastActive = active
  })
  editor.events.on('tool', syncTool)
  editor.events.on('history', syncHistory)
  editor.events.on('view', syncView)
  editor.events.on('animation', syncVideoFps)
  syncVideoFps()
  for (const event of ['doc', 'animation', 'scene', 'transform', 'settings'] as const) editor.events.on(event, syncKeys)
  editor.events.on('time', () => {
    if (editor.playing) return
    syncView()
    syncKeys()
  })
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
  syncBadges()
  syncTool()
  syncHistory()
  syncBrush()
  syncView()
  keys.sync()

  // ── keyboard ─────────────────────────────────────────────────────────────

  /** The numpad is the view, as in Blender. Returns false for a key it has no use for. */
  function numpad(e: KeyboardEvent): boolean {
    const { nav } = editor
    const ctrl = e.ctrlKey
    switch (e.code) {
      case 'Numpad1': nav.snap(ctrl ? 'back' : 'front'); break
      case 'Numpad3': nav.snap(ctrl ? 'left' : 'right'); break
      case 'Numpad7': nav.snap(ctrl ? 'bottom' : 'top'); break
      case 'Numpad9': nav.opposite(); break
      case 'Numpad5': nav.toggleOrthographic(); break
      case 'Numpad0': gizmo.toggleCamera(); break
      // 4 6 8 2 orbit in steps of 15°; with Ctrl they pan
      case 'Numpad4': ctrl ? nav.pan(40, 0) : nav.orbit(-15, 0); break
      case 'Numpad6': ctrl ? nav.pan(-40, 0) : nav.orbit(15, 0); break
      case 'Numpad8': ctrl ? nav.pan(0, 40) : nav.orbit(0, -15); break
      case 'Numpad2': ctrl ? nav.pan(0, -40) : nav.orbit(0, 15); break
      case 'NumpadAdd': nav.zoom(0.85); break
      case 'NumpadSubtract': nav.zoom(1.18); break
      case 'NumpadDecimal': editor.frame(); break
      default: return false
    }
    return true
  }

  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target) || previewDialog.open) return
    // before the tools' own 1, 2 and 3, which the numpad's digits would otherwise pick up;
    // a key the focused viewport already acted on (its own + and −) is left alone
    if (e.code.startsWith('Numpad') && editor.doc && !e.altKey && !e.metaKey && !e.defaultPrevented && numpad(e)) {
      e.preventDefault()
      return
    }
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

    // the timeline's keys, Blender-like: Space plays, K keys, Shift+K keys the camera
    if (key === ' ') {
      // a focused button would also take the Space as a click
      if (e.target instanceof HTMLElement) e.target.blur()
      editor.togglePlay()
      e.preventDefault()
      return
    }
    if (key === 'k') {
      if (e.shiftKey) editor.keyCamera()
      else editor.keySelected()
      e.preventDefault()
      return
    }
    if (key === 'home') {
      editor.setTime(0)
      e.preventDefault()
      return
    }
    if (key === 't') {
      document.body.classList.toggle('timeline-closed')
      e.preventDefault()
      return
    }

    const tool = tools.find((t) => t.key.toLowerCase() === key)
    if (tool) editor.setTool(tool.id)
    else if (key === 'delete' || key === 'backspace') {
      // a selected keyframe goes first, then splats; with neither, the Label tool's Delete removes the active label
      if (timeline.deleteSelected()) {
        // handled
      } else if (editor.doc?.state.selected) editor.deleteSelected()
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
