import { Mat4, type Entity } from 'playcanvas'
import { DEFAULT_ANNOTATION_OFFSET, type Annotation } from './scene'

/**
 * Styles for the callout layer. It is a string because the layer lives in two places: the
 * player's shadow root and the editor's viewport.
 *
 *   --splat-label-color   text, leader line and dot   (default: --splat-fg, then #fff)
 *   --splat-label-bg      fill behind the text        (default: transparent)
 *   --splat-label-width   widest a callout may get    (default: 15em)
 *
 * With no fill, legibility over the splat comes from a halo in the stage color (--splat-bg).
 */
export const annotationCss = /* css */ `
.sa-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  color: var(--splat-label-color, var(--splat-fg, #fff));
  font-size: 13px;
  line-height: 1.35;
}
.sa-layer[hidden] { display: none; }
.sa-item { position: absolute; left: 0; top: 0; }
.sa-item[hidden] { display: none; }
.sa-dot {
  position: absolute;
  left: -4px;
  top: -4px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--splat-bg, #000) 55%, transparent);
}
.sa-line { position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible; }
.sa-line line {
  stroke: currentColor;
  stroke-width: 1;
  /* the same halo the text gets, so the leader survives a busy background */
  filter: drop-shadow(0 0 1.5px var(--splat-bg, #000));
}
.sa-label {
  position: absolute;
  left: 0;
  top: 0;
  box-sizing: border-box;
  width: max-content;
  max-width: var(--splat-label-width, 15em);
  padding: 5px 2px 2px;
  /* the leader line arrives at this rule and runs on along the top of the text */
  border-top: 1px solid currentColor;
  background: var(--splat-label-bg, transparent);
  text-shadow: 0 0 2px var(--splat-bg, #000), 0 0 5px var(--splat-bg, #000), 0 0 10px var(--splat-bg, #000);
  overflow-wrap: anywhere;
}
.sa-label.left { text-align: right; }
.sa-title { display: block; font-weight: 600; }
.sa-text { display: block; white-space: pre-line; opacity: 0.88; }
.sa-title + .sa-text { margin-top: 1px; }

/* editing: the dot and the text become handles */
.sa-layer.editable .sa-dot, .sa-layer.editable .sa-label { pointer-events: auto; touch-action: none; cursor: grab; }
.sa-layer.editable .sa-dot { left: -6px; top: -6px; width: 12px; height: 12px; }
.sa-layer.editable .sa-item.selected { color: #ffc81a; }
.sa-layer.editable .sa-label:empty::before { content: "Empty label"; opacity: 0.6; }
`

export interface AnnotationHandlers {
  onSelect?(index: number): void
  /** A drag of the text or the dot is starting / has finished: one undo step */
  onDragStart?(index: number): void
  onDragEnd?(index: number): void
  /** The text was dragged to a new offset from its point */
  onLabelMove?(index: number, offset: [number, number]): void
  /** The dot is being dragged; the owner decides which 3D point is under the pointer */
  onAnchorMove?(index: number, clientX: number, clientY: number): void
}

interface Item {
  root: HTMLElement
  line: SVGLineElement
  label: HTMLElement
  x: number
  y: number
  dx: number
  dy: number
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Text callouts pinned to points in the scene: an HTML layer over the canvas whose items
 * follow their 3D anchors as the camera moves. Being real text, the callouts stay sharp at
 * any pixel ratio, can be read by assistive tech, and take their type from the page.
 */
export class AnnotationLayer {
  readonly root: HTMLElement
  handlers: AnnotationHandlers = {}

  private readonly camera: Entity
  private readonly canvas: HTMLCanvasElement
  private annotations: readonly Annotation[] = []
  private items: Item[] = []
  private culled: ((x: number, y: number, z: number) => boolean) | null = null
  private selected: number | null = null
  private readonly viewProjection = new Mat4()

  constructor(parent: ParentNode, camera: Entity, canvas: HTMLCanvasElement, before: Node | null = null) {
    this.camera = camera
    this.canvas = canvas
    this.root = document.createElement('div')
    this.root.className = 'sa-layer'
    this.root.setAttribute('role', 'list')
    this.root.setAttribute('aria-label', 'Annotations')
    parent.insertBefore(this.root, before)
  }

  destroy() {
    this.root.remove()
    this.items = []
  }

  get visible() {
    return !this.root.hidden
  }

  set visible(value: boolean) {
    this.root.hidden = !value
    if (value) this.update()
  }

  /** In the editor the dot and the text are draggable; in the player the layer ignores the pointer */
  set editable(value: boolean) {
    this.root.classList.toggle('editable', value)
  }

  /**
   * Replace the callouts. `culled` reports whether a world point is hidden by a section
   * box; a callout whose point is cut away is hidden with it.
   */
  set(annotations: readonly Annotation[], culled: ((x: number, y: number, z: number) => boolean) | null = null) {
    this.annotations = annotations
    this.culled = culled
    this.items = annotations.map((annotation, index) => this.build(annotation, index))
    this.root.replaceChildren(...this.items.map((item) => item.root))
    this.setSelected(this.selected)
    this.update()
  }

  setSelected(index: number | null) {
    this.selected = index
    this.items.forEach((item, i) => item.root.classList.toggle('selected', i === index))
  }

  private build(annotation: Annotation, index: number): Item {
    const root = document.createElement('div')
    root.className = 'sa-item'
    root.setAttribute('role', 'listitem')
    root.hidden = true

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'sa-line')
    svg.setAttribute('aria-hidden', 'true')
    const line = document.createElementNS(SVG_NS, 'line')
    svg.append(line)

    const dot = document.createElement('span')
    dot.className = 'sa-dot'

    const label = document.createElement('div')
    label.className = 'sa-label'
    if (annotation.title) {
      const title = document.createElement('span')
      title.className = 'sa-title'
      title.textContent = annotation.title
      label.append(title)
    }
    if (annotation.text) {
      const body = document.createElement('span')
      body.className = 'sa-text'
      body.textContent = annotation.text
      label.append(body)
    }

    root.append(svg, dot, label)
    const item: Item = { root, line, label, x: NaN, y: NaN, dx: NaN, dy: NaN }
    this.bindDrag(label, index, 'label')
    this.bindDrag(dot, index, 'anchor')
    return item
  }

  private bindDrag(handle: HTMLElement, index: number, kind: 'label' | 'anchor') {
    let pointerId: number | null = null
    let last = { x: 0, y: 0 }
    let offset: [number, number] = [0, 0]

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || pointerId !== null) return
      e.preventDefault()
      e.stopPropagation()
      pointerId = e.pointerId
      try {
        handle.setPointerCapture(e.pointerId)
      } catch {
        // the pointer was already released; the drag simply ends when it leaves the handle
      }
      last = { x: e.clientX, y: e.clientY }
      offset = [...(this.annotations[index]?.offset ?? DEFAULT_ANNOTATION_OFFSET)]
      this.handlers.onSelect?.(index)
      this.handlers.onDragStart?.(index)
    })
    handle.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId) return
      if (kind === 'label') {
        offset = [Math.round(offset[0] + e.clientX - last.x), Math.round(offset[1] + e.clientY - last.y)]
        last = { x: e.clientX, y: e.clientY }
        this.handlers.onLabelMove?.(index, offset)
      } else {
        this.handlers.onAnchorMove?.(index, e.clientX, e.clientY)
      }
    })
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      pointerId = null
      this.handlers.onDragEnd?.(index)
    }
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  /** Re-project every callout. Cheap enough to call each frame; it only writes what moved. */
  update() {
    if (this.root.hidden || this.items.length === 0) return
    const camera = this.camera.camera
    if (!camera) return
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    const m = this.viewProjection.mul2(camera.projectionMatrix, camera.viewMatrix).data

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]
      const annotation = this.annotations[i]
      const [px, py, pz] = annotation.position
      const w = m[3] * px + m[7] * py + m[11] * pz + m[15]
      const nx = (m[0] * px + m[4] * py + m[8] * pz + m[12]) / w
      const ny = (m[1] * px + m[5] * py + m[9] * pz + m[13]) / w
      // behind the camera, outside the frame, or cut away by a section box
      const hidden = w <= 0 || Math.abs(nx) > 1 || Math.abs(ny) > 1 || (this.culled?.(px, py, pz) ?? false)
      if (item.root.hidden !== hidden) item.root.hidden = hidden
      if (hidden) continue

      const x = Math.round((nx * 0.5 + 0.5) * width)
      const y = Math.round((0.5 - ny * 0.5) * height)
      if (x !== item.x || y !== item.y) {
        item.x = x
        item.y = y
        item.root.style.transform = `translate(${x}px, ${y}px)`
      }

      const [dx, dy] = annotation.offset ?? DEFAULT_ANNOTATION_OFFSET
      if (dx !== item.dx || dy !== item.dy) {
        item.dx = dx
        item.dy = dy
        item.line.setAttribute('x2', String(dx))
        item.line.setAttribute('y2', String(dy))
        // text grows away from its point: rightwards when placed to the right, leftwards otherwise
        const left = dx < 0
        item.label.classList.toggle('left', left)
        item.label.style.transform = left ? `translate(calc(${dx}px - 100%), ${dy}px)` : `translate(${dx}px, ${dy}px)`
      }
    }
  }
}
