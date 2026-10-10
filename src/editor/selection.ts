export type SelectMode = 'set' | 'add' | 'remove'
export type SelectionTool = 'rect' | 'lasso' | 'brush'

/** Tests a point in CSS pixels, relative to the canvas, against the drawn selection shape. */
export type ScreenTest = (x: number, y: number) => boolean

interface Point {
  x: number
  y: number
}

/** Capture can be refused (the pointer was already released); the gesture still works without it. */
const capture = (element: Element, pointerId: number) => {
  try {
    element.setPointerCapture(pointerId)
  } catch {
    // not an active pointer
  }
}

const STROKE = '#ffc81a'
const FILL = 'rgba(255, 200, 26, 0.16)'
const CLICK_SLOP = 3

/**
 * Screen-space selection gestures. It listens on the 3D canvas, draws the shape being made
 * on a 2D overlay stacked above it, and on release hands the host a point-in-shape test; the
 * host decides which splats fall inside.
 */
export class SelectionTools {
  tool: SelectionTool | null = null
  /** Brush radius in CSS pixels */
  brushRadius = 28
  onSelect: ((test: ScreenTest, mode: SelectMode) => void) | null = null

  private readonly canvas: HTMLCanvasElement
  private readonly overlay: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  // lasso and brush shapes are rasterised here, then sampled per splat
  private readonly mask = document.createElement('canvas')
  private readonly maskCtx: CanvasRenderingContext2D
  private readonly abort = new AbortController()

  private pointerId: number | null = null
  private mode: SelectMode = 'set'
  private start: Point = { x: 0, y: 0 }
  private last: Point = { x: 0, y: 0 }
  private path: Point[] = []
  private hover: Point | null = null

  constructor(canvas: HTMLCanvasElement, overlay: HTMLCanvasElement) {
    this.canvas = canvas
    this.overlay = overlay
    this.ctx = overlay.getContext('2d')!
    this.maskCtx = this.mask.getContext('2d', { willReadFrequently: true })!
    const opts = { signal: this.abort.signal }
    canvas.addEventListener('pointerdown', this.onDown, opts)
    canvas.addEventListener('pointermove', this.onMove, opts)
    canvas.addEventListener('pointerup', this.onUp, opts)
    canvas.addEventListener('pointercancel', this.onCancel, opts)
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.draw() }, opts)
  }

  destroy() {
    this.abort.abort()
  }

  get dragging() {
    return this.pointerId !== null
  }

  setTool(tool: SelectionTool | null) {
    this.tool = tool
    this.pointerId = null
    this.path = []
    this.draw()
  }

  setBrushRadius(radius: number) {
    this.brushRadius = Math.min(200, Math.max(4, Math.round(radius)))
    this.draw()
  }

  private point(e: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  private onDown = (e: PointerEvent) => {
    // left button only; Alt+drag is reserved for orbiting while a selection tool is active
    if (!this.tool || e.button !== 0 || e.altKey || this.pointerId !== null) return
    this.pointerId = e.pointerId
    capture(this.canvas, e.pointerId)
    this.mode = e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'remove' : 'set'
    this.start = this.last = this.point(e)
    this.path = [this.start]

    this.mask.width = this.canvas.clientWidth
    this.mask.height = this.canvas.clientHeight
    if (this.tool === 'brush') this.dab(this.start, this.start)
    this.draw()
  }

  private onMove = (e: PointerEvent) => {
    const p = this.point(e)
    this.hover = p
    if (e.pointerId === this.pointerId) {
      if (this.tool === 'brush') this.dab(this.last, p)
      if (this.tool === 'lasso') this.path.push(p)
      this.last = p
    }
    this.draw()
  }

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return
    this.pointerId = null
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
    const test = this.buildTest()
    this.path = []
    this.draw()
    this.onSelect?.(test, this.mode)
  }

  private onCancel = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return
    this.pointerId = null
    this.path = []
    this.draw()
  }

  private dab(from: Point, to: Point) {
    const ctx = this.maskCtx
    ctx.strokeStyle = ctx.fillStyle = '#fff'
    ctx.lineWidth = this.brushRadius * 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    // a zero-length line draws nothing in some browsers; nudge it so a click still leaves a dot
    ctx.lineTo(to.x + (from.x === to.x && from.y === to.y ? 0.01 : 0), to.y)
    ctx.stroke()
  }

  private buildTest(): ScreenTest {
    const { start, last } = this
    const moved = Math.hypot(last.x - start.x, last.y - start.y) > CLICK_SLOP

    if (this.tool === 'rect') {
      // a plain click selects nothing, which in 'set' mode clears the selection
      if (!moved) return () => false
      const x0 = Math.min(start.x, last.x)
      const x1 = Math.max(start.x, last.x)
      const y0 = Math.min(start.y, last.y)
      const y1 = Math.max(start.y, last.y)
      return (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1
    }

    if (this.tool === 'lasso') {
      // a closed loop ends where it began, so judge it by its extent, not by start-to-end distance
      const xs = this.path.map((p) => p.x)
      const ys = this.path.map((p) => p.y)
      const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
      if (this.path.length < 3 || extent <= CLICK_SLOP) return () => false
      const ctx = this.maskCtx
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      this.path.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
      ctx.closePath()
      ctx.fill()
    }

    const { width, height } = this.mask
    if (width === 0 || height === 0) return () => false
    const alpha = this.maskCtx.getImageData(0, 0, width, height).data
    return (x, y) => {
      const px = x | 0
      const py = y | 0
      if (px < 0 || py < 0 || px >= width || py >= height) return false
      return alpha[(py * width + px) * 4 + 3] > 127
    }
  }

  /** Repaint the overlay: the shape in progress plus the brush cursor. */
  draw() {
    const { overlay, ctx, canvas } = this
    const dpr = window.devicePixelRatio || 1
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (overlay.width !== Math.round(width * dpr) || overlay.height !== Math.round(height * dpr)) {
      overlay.width = Math.round(width * dpr)
      overlay.height = Math.round(height * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    if (!this.tool) return

    ctx.lineWidth = 1.25
    ctx.strokeStyle = STROKE
    ctx.fillStyle = FILL

    if (this.dragging) {
      if (this.tool === 'rect') {
        const x = Math.min(this.start.x, this.last.x)
        const y = Math.min(this.start.y, this.last.y)
        const w = Math.abs(this.last.x - this.start.x)
        const h = Math.abs(this.last.y - this.start.y)
        ctx.setLineDash([5, 4])
        ctx.fillRect(x, y, w, h)
        ctx.strokeRect(x + 0.5, y + 0.5, w, h)
        ctx.setLineDash([])
      } else if (this.tool === 'lasso') {
        ctx.beginPath()
        this.path.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      } else {
        // show the painted area itself, tinted
        ctx.globalAlpha = 0.3
        ctx.drawImage(this.mask, 0, 0, width, height)
        ctx.globalCompositeOperation = 'source-atop'
        ctx.globalAlpha = 1
        ctx.fillStyle = 'rgba(255, 200, 26, 0.5)'
        ctx.fillRect(0, 0, width, height)
        ctx.globalCompositeOperation = 'source-over'
      }
    }

    if (this.tool === 'brush' && this.hover) {
      ctx.beginPath()
      ctx.arc(this.hover.x, this.hover.y, this.brushRadius, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
}
