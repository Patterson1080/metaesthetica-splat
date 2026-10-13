import { Mat4, Quat, Vec3, type Entity } from 'playcanvas'
import { DEFAULT_ANNOTATION_OFFSET, type Annotation, type SectionBox } from '../core/scene'

// The labels are HTML over the canvas (core/annotations.ts, core/section-frames.ts), which a
// video cannot contain. This draws the same labels onto a 2D canvas, measure for measure:
// every number here mirrors one in `annotationCss` or in the two layers, in CSS pixels.

const FONT_SIZE = 12
const LINE_HEIGHT = 17
const TITLE_TRACKING = 0.16 // em
const TEXT_TRACKING = 0.03
const LABEL_MIN = 72 // 6em
const LABEL_MAX = 216 // 18em
const TITLE_GAP = 6 // between a title and its rule
const TEXT_GAP = 7 // between the rule and the text under it
const TICK_ABOVE = 3
const TICK_BELOW = 4
const DOT_RADIUS = 3

const FRAME_GAP = 14 // between a box and its text
const FRAME_MIN = 200
const FRAME_MAX = 460
const FRAME_TITLE = { size: 17, line: 24, gap: 10 }
const FRAME_TEXT = { size: 13, line: 19, gap: 12 }

const CORNERS = [-0.5, 0.5].flatMap((x) => [-0.5, 0.5].flatMap((y) => [-0.5, 0.5].map((z) => new Vec3(x, y, z))))
const EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7]

export interface LabelStyle {
  /** Text, rules, leaders and dots */
  color: string
  /** The stage color, for the halo that keeps text legible over the splat */
  halo: string
  /** A CSS font-family list */
  font: string
}

export interface LabelScene {
  camera: Entity
  annotations: readonly Annotation[]
  /** Reports whether a world point is cut away by a section box; its label goes with it */
  culled: ((x: number, y: number, z: number) => boolean) | null
  sections: readonly SectionBox[]
}

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** Letter-spacing on a canvas is newer than the type definitions */
const track = (ctx: Context, px: number) => ((ctx as unknown as { letterSpacing: string }).letterSpacing = `${px}px`)

/** Break text into lines no wider than `width`, keeping its own line breaks (CSS pre-line). */
function wrap(ctx: Context, text: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.trim().split(/\s+/)) {
      const next = line ? `${line} ${word}` : word
      if (!line || ctx.measureText(next).width <= width) {
        line = next
        continue
      }
      lines.push(line)
      line = word
    }
    // a single word wider than the label is broken where it must be (overflow-wrap: anywhere)
    while (line && ctx.measureText(line).width > width && line.length > 1) {
      let cut = line.length - 1
      while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > width) cut--
      lines.push(line.slice(0, cut))
      line = line.slice(cut)
    }
    lines.push(line)
  }
  return lines
}

/** A title that does not fit ends in an ellipsis, as it does on the page. */
function fit(ctx: Context, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text
  let cut = text.length
  while (cut > 1 && ctx.measureText(`${text.slice(0, cut)}…`).width > width) cut--
  return `${text.slice(0, cut)}…`
}

/**
 * Draw a scene's labels over a rendered frame. `width` and `height` are the frame's size in
 * pixels and `scale` how many of them a CSS pixel of the viewport is worth, so the labels
 * take up the same share of the picture as they do on screen.
 */
export function paintLabels(ctx: Context, width: number, height: number, scale: number, scene: LabelScene, style: LabelStyle) {
  const camera = scene.camera.camera
  if (!camera) return
  const viewProjection = new Mat4().mul2(camera.projectionMatrix, camera.viewMatrix)
  const px = (n: number) => n * scale
  const font = (size: number, weight: number) => `${weight} ${px(size)}px ${style.font}`

  ctx.save()
  ctx.lineCap = 'butt'
  ctx.textBaseline = 'middle'

  /** Text with the halo the page gives it: three soft shadows in the stage color */
  const text = (value: string, x: number, y: number) => {
    ctx.fillStyle = style.color
    ctx.shadowColor = style.halo
    for (const blur of [10, 5, 2]) {
      ctx.shadowBlur = px(blur)
      ctx.fillText(value, x, y)
    }
    ctx.shadowBlur = 0
  }
  /** A hairline, with a fainter halo */
  const line = (x1: number, y1: number, x2: number, y2: number, alpha = 1) => {
    ctx.strokeStyle = style.color
    ctx.globalAlpha = alpha
    ctx.lineWidth = Math.max(px(1), 1)
    ctx.shadowColor = style.halo
    ctx.shadowBlur = px(2)
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
    ctx.shadowBlur = 0
    ctx.globalAlpha = 1
  }
  /** The ruled line that closes a title or a text: a hairline with a tick at each end */
  const rule = (x: number, y: number, w: number) => {
    line(x, y, x + w, y)
    line(x, y - px(TICK_ABOVE), x, y + px(TICK_BELOW))
    line(x + w, y - px(TICK_ABOVE), x + w, y + px(TICK_BELOW))
  }

  // ── section frames: the box as a hairline cube, named above and described below ──

  const position = new Vec3()
  const rotation = new Quat()
  const size = new Vec3()
  const world = new Mat4()
  const clip = new Mat4()
  const xs = new Float32Array(8)
  const ys = new Float32Array(8)
  for (const box of scene.sections) {
    if (box.label !== true || box.enabled === false) continue
    position.set(box.position[0], box.position[1], box.position[2])
    rotation.setFromEulerAngles(box.rotation[0], box.rotation[1], box.rotation[2])
    size.set(box.size[0], box.size[1], box.size[2])
    const d = clip.mul2(viewProjection, world.setTRS(position, rotation, size)).data
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
      xs[i] = (((d[0] * c.x + d[4] * c.y + d[8] * c.z + d[12]) / w) * 0.5 + 0.5) * width
      ys[i] = (0.5 - ((d[1] * c.x + d[5] * c.y + d[9] * c.z + d[13]) / w) * 0.5) * height
      minX = Math.min(minX, xs[i])
      maxX = Math.max(maxX, xs[i])
      minY = Math.min(minY, ys[i])
      maxY = Math.max(maxY, ys[i])
    }
    if (behind || maxX < 0 || minX > width || maxY < 0 || minY > height) continue

    for (let e = 0; e < EDGES.length; e += 2) line(xs[EDGES[e]], ys[EDGES[e]], xs[EDGES[e + 1]], ys[EDGES[e + 1]], 0.85)

    // the text is as wide as the box looks, within reason, and centered on it
    const span = Math.min(Math.max(maxX - minX, px(FRAME_MIN)), px(FRAME_MAX))
    const left = Math.round((minX + maxX) / 2 - span / 2)

    // above: the name, then a rule, the rule a gap above the box
    const headRule = minY - px(FRAME_GAP)
    rule(left, headRule, span)
    ctx.font = font(FRAME_TITLE.size, 600)
    track(ctx, px(FRAME_TITLE.size * TITLE_TRACKING))
    ctx.textAlign = 'center'
    text(fit(ctx, (box.name || 'Component').toUpperCase(), span), left + span / 2, headRule - px(FRAME_TITLE.gap) - px(FRAME_TITLE.line) / 2)

    // below: the description, then a rule
    if (box.text) {
      ctx.font = font(FRAME_TEXT.size, 400)
      track(ctx, px(FRAME_TEXT.size * TEXT_TRACKING))
      ctx.textAlign = 'left'
      const lines = wrap(ctx, box.text, span)
      let y = maxY + px(FRAME_GAP)
      for (const value of lines) {
        text(value, left, y + px(FRAME_TEXT.line) / 2)
        y += px(FRAME_TEXT.line)
      }
      rule(left, y + px(FRAME_TEXT.gap), span)
    }
  }

  // ── pinned callouts: a dot on the point, a leader, and the label where it was placed ──

  const m = viewProjection.data
  for (const annotation of scene.annotations) {
    const [ax, ay, az] = annotation.position
    const w = m[3] * ax + m[7] * ay + m[11] * az + m[15]
    const nx = (m[0] * ax + m[4] * ay + m[8] * az + m[12]) / w
    const ny = (m[1] * ax + m[5] * ay + m[9] * az + m[13]) / w
    // behind the camera, outside the frame, or cut away by a section box
    if (w <= 0 || Math.abs(nx) > 1 || Math.abs(ny) > 1 || scene.culled?.(ax, ay, az)) continue
    // a label with neither title nor text only exists in the editor, as something to grab
    if (!annotation.title && !annotation.text) continue

    const x = Math.round((nx * 0.5 + 0.5) * width)
    const y = Math.round((0.5 - ny * 0.5) * height)
    const [ox, oy] = annotation.offset ?? DEFAULT_ANNOTATION_OFFSET
    const lx = x + px(ox)
    const ly = y + px(oy)
    const leftward = ox < 0

    // as wide as its widest line, within the same bounds as on the page
    const title = annotation.title ? annotation.title.toUpperCase() : ''
    ctx.font = font(FONT_SIZE, 400)
    track(ctx, px(FONT_SIZE * TEXT_TRACKING))
    const lines = annotation.text ? wrap(ctx, annotation.text, px(LABEL_MAX)) : []
    let labelWidth = Math.max(px(LABEL_MIN), ...lines.map((value) => ctx.measureText(value).width))
    ctx.font = font(FONT_SIZE, 600)
    track(ctx, px(FONT_SIZE * TITLE_TRACKING))
    if (title) labelWidth = Math.max(labelWidth, ctx.measureText(title).width)
    labelWidth = Math.min(Math.ceil(labelWidth), px(LABEL_MAX))
    // text grows away from its point: rightwards when placed to the right, leftwards otherwise
    const left = leftward ? lx - labelWidth : lx
    const edge = leftward ? left + labelWidth : left
    ctx.textAlign = leftward ? 'right' : 'left'

    line(x, y, lx, ly)
    // the dot, ringed in the stage color so it shows on any ground
    ctx.beginPath()
    ctx.arc(x, y, px(DOT_RADIUS + 2), 0, Math.PI * 2)
    ctx.fillStyle = style.halo
    ctx.globalAlpha = 0.55
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.beginPath()
    ctx.arc(x, y, px(DOT_RADIUS), 0, Math.PI * 2)
    ctx.fillStyle = style.color
    ctx.fill()

    // the leader meets the rule; a title rides above it, the text hangs below
    rule(left, ly, labelWidth)
    if (title) text(fit(ctx, title, labelWidth), edge, ly - px(TITLE_GAP) - px(LINE_HEIGHT) / 2)
    ctx.font = font(FONT_SIZE, 400)
    track(ctx, px(FONT_SIZE * TEXT_TRACKING))
    let ty = ly + px(TEXT_GAP)
    for (const value of lines) {
      text(value, edge, ty + px(LINE_HEIGHT) / 2)
      ty += px(LINE_HEIGHT)
    }
  }

  ctx.restore()
}
