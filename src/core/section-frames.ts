import { Mat4, Quat, Vec3, type Entity } from 'playcanvas'
import type { SectionBox } from './scene'

interface Item {
  box: SectionBox
  root: HTMLElement
  lines: SVGLineElement[]
  head: HTMLElement
  foot: HTMLElement | null
  /** Maps the box's unit cube to world space */
  matrix: Mat4
}

const SVG_NS = 'http://www.w3.org/2000/svg'
// the 12 edges of a cube, as index pairs into its 8 corners
const CORNERS = [-0.5, 0.5].flatMap((x) => [-0.5, 0.5].flatMap((y) => [-0.5, 0.5].map((z) => new Vec3(x, y, z))))
const EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7]

const GAP = 14 // CSS pixels between the box and its text
const MIN_WIDTH = 200
const MAX_WIDTH = 460

/**
 * Labels for section boxes: the box drawn as a hairline cube with its name set above it and
 * its description below, each closed by a ruled line. A box then reads as a named component
 * of the splat. Like the pinned callouts this is HTML over the canvas, so the text is real
 * text, and it shares their styles (see `annotationCss`).
 */
export class SectionFrameLayer {
  readonly root: HTMLElement

  private readonly camera: Entity
  private readonly canvas: HTMLCanvasElement
  private items: Item[] = []
  private readonly viewProjection = new Mat4()

  constructor(parent: ParentNode, camera: Entity, canvas: HTMLCanvasElement, before: Node | null = null) {
    this.camera = camera
    this.canvas = canvas
    this.root = document.createElement('div')
    this.root.className = 'sa-layer sf-layer'
    this.root.setAttribute('role', 'list')
    this.root.setAttribute('aria-label', 'Components')
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

  /** Show a frame for every enabled box that asks for a label. */
  set(sections: readonly SectionBox[]) {
    const position = new Vec3()
    const rotation = new Quat()
    const size = new Vec3()
    this.items = sections
      .filter((box) => box.label === true && box.enabled !== false)
      .map((box) => {
        position.set(box.position[0], box.position[1], box.position[2])
        rotation.setFromEulerAngles(box.rotation[0], box.rotation[1], box.rotation[2])
        size.set(box.size[0], box.size[1], box.size[2])
        return this.build(box, new Mat4().setTRS(position, rotation, size))
      })
    this.root.replaceChildren(...this.items.map((item) => item.root))
    this.update()
  }

  /** The boxes moved (an animation is playing): take their new places, keeping the same elements. */
  refresh() {
    const position = new Vec3()
    const rotation = new Quat()
    const size = new Vec3()
    for (const { box, matrix } of this.items) {
      position.set(box.position[0], box.position[1], box.position[2])
      rotation.setFromEulerAngles(box.rotation[0], box.rotation[1], box.rotation[2])
      size.set(box.size[0], box.size[1], box.size[2])
      matrix.setTRS(position, rotation, size)
    }
  }

  private build(box: SectionBox, matrix: Mat4): Item {
    const root = document.createElement('div')
    root.className = 'sf-item'
    root.setAttribute('role', 'listitem')
    root.hidden = true

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'sf-edges')
    svg.setAttribute('aria-hidden', 'true')
    const lines = Array.from({ length: EDGES.length / 2 }, () => svg.appendChild(document.createElementNS(SVG_NS, 'line')))

    const head = document.createElement('div')
    head.className = 'sf-head'
    const title = document.createElement('span')
    title.className = 'sa-title'
    title.textContent = box.name || 'Component'
    const rule = () => {
      const node = document.createElement('i')
      node.className = 'sa-rule'
      return node
    }
    head.append(title, rule())

    let foot: HTMLElement | null = null
    if (box.text) {
      foot = document.createElement('div')
      foot.className = 'sf-foot'
      const text = document.createElement('span')
      text.className = 'sa-text'
      text.textContent = box.text
      foot.append(text, rule())
    }

    root.append(svg, head)
    if (foot) root.append(foot)
    return { box, root, lines, head, foot, matrix }
  }

  /** Re-project every frame. Call each frame; it is a few dozen multiplications per box. */
  update() {
    if (this.root.hidden || this.items.length === 0) return
    const camera = this.camera.camera
    if (!camera) return
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    const vp = this.viewProjection.mul2(camera.projectionMatrix, camera.viewMatrix)
    const m = new Mat4()
    const xs = new Float32Array(8)
    const ys = new Float32Array(8)

    for (const item of this.items) {
      const d = m.mul2(vp, item.matrix).data
      let behind = false
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (let i = 0; i < 8; i++) {
        const c = CORNERS[i]
        const w = d[3] * c.x + d[7] * c.y + d[11] * c.z + d[15]
        if (w <= 0) {
          behind = true
          break
        }
        const x = (((d[0] * c.x + d[4] * c.y + d[8] * c.z + d[12]) / w) * 0.5 + 0.5) * width
        const y = (0.5 - ((d[1] * c.x + d[5] * c.y + d[9] * c.z + d[13]) / w) * 0.5) * height
        xs[i] = x
        ys[i] = y
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      // a box with a corner behind the camera cannot be drawn honestly; nor is one wholly out of frame worth drawing
      const hidden = behind || maxX < 0 || minX > width || maxY < 0 || minY > height
      if (item.root.hidden !== hidden) item.root.hidden = hidden
      if (hidden) continue

      for (let e = 0; e < item.lines.length; e++) {
        const a = EDGES[e * 2]
        const b = EDGES[e * 2 + 1]
        const line = item.lines[e]
        line.setAttribute('x1', xs[a].toFixed(1))
        line.setAttribute('y1', ys[a].toFixed(1))
        line.setAttribute('x2', xs[b].toFixed(1))
        line.setAttribute('y2', ys[b].toFixed(1))
      }

      // the text is as wide as the box looks, within reason, and centered on it
      const span = Math.min(Math.max(maxX - minX, MIN_WIDTH), MAX_WIDTH)
      const left = Math.round((minX + maxX) / 2 - span / 2)
      item.head.style.width = `${Math.round(span)}px`
      item.head.style.transform = `translate(${left}px, ${Math.round(minY - GAP)}px) translateY(-100%)`
      if (item.foot) {
        item.foot.style.width = `${Math.round(span)}px`
        item.foot.style.transform = `translate(${left}px, ${Math.round(maxY + GAP)}px)`
      }
    }
  }
}
