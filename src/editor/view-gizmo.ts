import { h, icons } from './dom'
import type { Editor } from './editor'
import { AXIS_VIEWS, type AxisView } from './view-nav'

const SVG = 'http://www.w3.org/2000/svg'
const REACH = 33 // from the centre of the gizmo to the centre of a bubble, in viewBox units
const BUBBLE = 9.5
const ORBIT_SPEED = 0.6 // degrees per CSS pixel: the gizmo is small, so it turns faster than the viewport does
const ZOOM_SPEED = 0.01
const DRAG_SLOP = 3
const KEY_STEP = 16 // pixels a press of an arrow key stands for on the zoom and pan buttons

// one bubble per end of each world axis, named for the view it gives
const ENDS: { view: AxisView; axis: 'x' | 'y' | 'z'; dir: [number, number, number]; label: string }[] = [
  { view: 'right', axis: 'x', dir: [1, 0, 0], label: 'X' },
  { view: 'left', axis: 'x', dir: [-1, 0, 0], label: '−X' },
  { view: 'top', axis: 'y', dir: [0, 1, 0], label: 'Y' },
  { view: 'bottom', axis: 'y', dir: [0, -1, 0], label: '−Y' },
  { view: 'front', axis: 'z', dir: [0, 0, 1], label: 'Z' },
  { view: 'back', axis: 'z', dir: [0, 0, -1], label: '−Z' },
]

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const node = document.createElementNS(SVG, tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value))
  return node
}

/** A button that is dragged rather than clicked; the arrow keys stand in for the drag. */
function dragButton(label: string, title: string, icon: string, onDrag: (dx: number, dy: number) => void) {
  const node = h('button', { type: 'button', title, attrs: { 'aria-label': label } })
  node.innerHTML = icon
  let pointerId: number | null = null
  let last = { x: 0, y: 0 }
  node.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    pointerId = e.pointerId
    last = { x: e.clientX, y: e.clientY }
    try {
      node.setPointerCapture(e.pointerId)
    } catch {
      // not an active pointer
    }
  })
  node.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return
    onDrag(e.clientX - last.x, e.clientY - last.y)
    last = { x: e.clientX, y: e.clientY }
  })
  const end = (e: PointerEvent) => {
    if (e.pointerId === pointerId) pointerId = null
  }
  node.addEventListener('pointerup', end)
  node.addEventListener('pointercancel', end)
  node.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP] }[e.key]
    if (!step) return
    onDrag(step[0], step[1])
    e.preventDefault()
    e.stopPropagation()
  })
  return node
}

/**
 * Blender's navigation gizmo, in the top right corner of the viewport: the world's axes as
 * the camera sees them. Click an end to look along that axis (click it again for the
 * opposite side), drag anywhere on it to orbit. Under it, as in Blender: zoom, pan, look
 * through the camera, and perspective / orthographic. The name of the view is written in
 * the opposite corner.
 */
export function buildViewGizmo(viewport: HTMLElement, editor: Editor) {
  const { nav } = editor
  const { camera } = editor.viewer

  // ── the axes ─────────────────────────────────────────────────────────────

  const ball = svg('svg', { viewBox: '-50 -50 100 100', class: 'vg-ball', role: 'group', 'aria-label': 'View axes: click an end to look along it, drag to orbit' })
  ball.append(svg('circle', { r: 49, class: 'vg-backdrop' }))
  const ends = ENDS.map((end) => {
    const positive = !end.label.startsWith('−')
    const view = AXIS_VIEWS[end.view]
    const node = svg('g', { class: `vg-end vg-${end.axis}${positive ? '' : ' vg-neg'}`, 'data-view': end.view, role: 'button', 'aria-label': `${view.label} view, from ${view.axis}` })
    const title = svg('title')
    title.textContent = `${view.label} view (looking from ${view.axis})`
    // only the positive ends have an arm back to the centre
    const arm = positive ? svg('line', { x1: 0, y1: 0, class: 'vg-arm' }) : null
    const bubble = svg('circle', { r: BUBBLE })
    const text = svg('text')
    text.textContent = end.label
    node.append(title, ...(arm ? [arm] : []), bubble, text)
    ball.append(node)
    return { ...end, node, arm, bubble, text, depth: 0 }
  })

  let drawn = ''
  let order = ''
  function draw() {
    const { right, up, forward } = camera
    const key = `${right.x.toFixed(3)},${right.y.toFixed(3)},${right.z.toFixed(3)},${up.x.toFixed(3)},${up.y.toFixed(3)},${up.z.toFixed(3)}`
    if (key === drawn) return
    drawn = key
    for (const end of ends) {
      const [x, y, z] = end.dir
      const sx = (x * right.x + y * right.y + z * right.z) * REACH
      const sy = -(x * up.x + y * up.y + z * up.z) * REACH
      // 1 points at the viewer, -1 away
      end.depth = -(x * forward.x + y * forward.y + z * forward.z)
      end.bubble.setAttribute('cx', sx.toFixed(2))
      end.bubble.setAttribute('cy', sy.toFixed(2))
      end.text.setAttribute('x', sx.toFixed(2))
      end.text.setAttribute('y', sy.toFixed(2))
      end.arm?.setAttribute('x2', sx.toFixed(2))
      end.arm?.setAttribute('y2', sy.toFixed(2))
      // ends pointing away sit back a little
      end.node.style.opacity = (0.62 + 0.38 * Math.min(Math.max(end.depth + 1, 0), 1)).toFixed(2)
    }
    // nearer ends are drawn over farther ones; the nodes only move when that order changes,
    // since re-inserting one from under the pointer would make its hover flicker
    const sorted = [...ends].sort((a, b) => a.depth - b.depth)
    const next = sorted.map((end) => end.view).join()
    if (next !== order) {
      order = next
      for (const end of sorted) ball.append(end.node)
    }
  }

  let pointerId: number | null = null
  let start = { x: 0, y: 0 }
  let last = { x: 0, y: 0 }
  let dragging = false
  let pressed: AxisView | null = null
  ball.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    pointerId = e.pointerId
    start = last = { x: e.clientX, y: e.clientY }
    dragging = false
    pressed = ((e.target as Element).closest('[data-view]')?.getAttribute('data-view') as AxisView | null) ?? null
    try {
      ball.setPointerCapture(e.pointerId)
    } catch {
      // not an active pointer
    }
    e.preventDefault()
  })
  ball.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return
    if (!dragging) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_SLOP) return
      dragging = true
      ball.classList.add('dragging')
    }
    nav.orbit(-(e.clientX - last.x) * ORBIT_SPEED, -(e.clientY - last.y) * ORBIT_SPEED)
    last = { x: e.clientX, y: e.clientY }
  })
  const release = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    pointerId = null
    ball.classList.remove('dragging')
    // a press that did not turn into a drag is a click on whatever end was under it
    if (!dragging && pressed && e.type === 'pointerup') nav.snap(pressed, true)
    dragging = false
  }
  ball.addEventListener('pointerup', release)
  ball.addEventListener('pointercancel', release)

  // ── the buttons under them ───────────────────────────────────────────────

  const zoom = dragButton('Zoom', 'Zoom: drag up or down (or scroll in the viewport)', icons.zoom, (_dx, dy) => nav.zoom(Math.exp(dy * ZOOM_SPEED)))
  zoom.classList.add('vg-zoom')
  const pan = dragButton('Pan', 'Pan: drag (or right-drag in the viewport)', icons.hand, (dx, dy) => nav.pan(dx, dy))
  pan.classList.add('vg-pan')
  const throughCamera = h('button', {
    type: 'button',
    title: 'Look through the animated camera (Numpad 0)',
    attrs: { 'aria-label': 'Look through the animated camera' },
    on: { click: () => toggleCamera() },
  })
  throughCamera.innerHTML = icons.tabCamera
  const projection = h('button', { type: 'button', on: { click: () => nav.toggleOrthographic() } })

  function toggleCamera() {
    const on = !editor.followCamera
    editor.setFollowCamera(on)
    if (!on) editor.events.emit('notice', 'The viewport is free. The camera’s path is drawn in yellow.')
    else if (!editor.hasCameraKeys) editor.events.emit('notice', 'The camera has no keys yet: move the view, then press Shift+K to key it')
    else editor.events.emit('notice', 'Looking through the animated camera')
  }

  const name = h('div', { class: 'view-name', attrs: { 'aria-live': 'polite' } })
  const tools = h('div', { class: 'vg-tools' }, zoom, pan, throughCamera, projection)
  const root = h('div', { class: 'view-gizmo' })
  root.append(ball, tools)
  viewport.append(root, name)

  let shown: boolean | null = null
  function sync() {
    draw()
    if (name.textContent !== nav.name) name.textContent = nav.name
    throughCamera.setAttribute('aria-pressed', String(editor.followCamera))
    const ortho = nav.orthographic
    if (ortho === shown) return
    shown = ortho
    projection.innerHTML = ortho ? icons.ortho : icons.persp
    const hint = ortho ? 'Orthographic. Click for perspective (Numpad 5)' : 'Perspective. Click for orthographic (Numpad 5)'
    projection.title = hint
    projection.setAttribute('aria-label', hint)
    projection.setAttribute('aria-pressed', String(ortho))
  }

  editor.events.on('view', sync)
  editor.events.on('animation', sync)
  editor.events.on('doc', sync)
  sync()

  return { toggleCamera }
}
