import {
  Entity,
  Gizmo,
  Mat4,
  RenderComponentSystem,
  RotateGizmo,
  ScaleGizmo,
  TranslateGizmo,
  Vec3,
  type GSplatData,
  type TransformGizmo,
} from 'playcanvas'
import { AnnotationLayer } from '../core/annotations'
import { SectionFrameLayer } from '../core/section-frames'
import { SplatEffects } from '../core/effects'
import { Emitter } from '../core/events'
import {
  DEFAULT_ANNOTATION_OFFSET,
  DEFAULT_BACKGROUND,
  DEFAULT_FOV,
  DEFAULT_REST_OPACITY,
  DEFAULT_ROTATION,
  FORCE_DEFAULTS,
  MAX_FORCES,
  MAX_SECTIONS,
  restOpacity,
  type Annotation,
  type CameraPose,
  type ControlLimits,
  type Force,
  type ForceType,
  type SectionBox,
  type SectionRest,
  type SplatScene,
  type Vec3Tuple,
} from '../core/scene'
import { sectionTest } from '../core/sections'
import { SplatViewer, tupleOf, type DeviceType, type LoadedSplat, type SplatInput } from '../core/viewer'
import { History, diffBytes } from './history'
import { exportPly } from './ply-export'
import { SelectionTools, type ScreenTest, type SelectMode } from './selection'
import { DELETED, SELECTED, SplatState } from './splat-state'

export type Tool = 'navigate' | 'rect' | 'lasso' | 'brush' | 'move' | 'rotate' | 'scale' | 'annotate'

const SELECT_TOOLS = ['rect', 'lasso', 'brush'] as const
const GIZMO_TOOLS = ['move', 'rotate', 'scale'] as const
const isSelectTool = (tool: Tool): tool is (typeof SELECT_TOOLS)[number] => (SELECT_TOOLS as readonly string[]).includes(tool)
const isGizmoTool = (tool: Tool): tool is (typeof GIZMO_TOOLS)[number] => (GIZMO_TOOLS as readonly string[]).includes(tool)

export interface Transform {
  position: Vec3Tuple
  rotation: Vec3Tuple
  scale: Vec3Tuple
}

/** Everything about the scene that is not the splat itself; this is what "Export scene" writes. */
export interface SceneSettings {
  fov: number
  background: string | null
  /** The view the player opens with; null = wherever the editor camera is at export time */
  initial: CameraPose | null
  poses: CameraPose[]
  controls: Required<ControlLimits>
  sections: SectionBox[]
  /** How the splats the boxes leave out are shown */
  sectionRest: SectionRest
  annotations: Annotation[]
  forces: Force[]
}

const defaultSettings = (): SceneSettings => ({
  fov: DEFAULT_FOV,
  background: DEFAULT_BACKGROUND,
  initial: null,
  poses: [],
  controls: { minDistance: 0.1, maxDistance: 50, minPitch: -89, maxPitch: 89, pan: true, autoRotate: 0 },
  sections: [],
  // in a new scene a cut shows its context faintly; it can be faded further or switched off
  sectionRest: { opacity: DEFAULT_REST_OPACITY, hidden: false },
  annotations: [],
  forces: [],
})

/** The splat being edited. */
export interface Doc {
  splat: LoadedSplat
  state: SplatState
  effects: SplatEffects
  /** File name without its extension, used to name exports */
  name: string
}

/** A section box or force that the gizmo tools are pointed at instead of the splat */
export interface ActiveObject {
  kind: 'section' | 'force'
  index: number
}

type EditorEvents = {
  /** A splat was opened or closed */
  doc: []
  /** Selection, deletion or counts changed */
  selection: []
  /** The splat's transform changed (gizmo drag, numeric entry, undo) */
  transform: []
  /** Scene settings changed */
  settings: []
  /** Section boxes, forces or callouts changed, or a different one became active */
  scene: []
  tool: [tool: Tool]
  history: []
  /** A long task started (message) or finished (null) */
  busy: [message: string | null]
  /** A short message for the status bar */
  notice: [message: string]
}

const GRID_EXTENT = 10
const CIRCLE_STEPS = 48
const PICK_RADIUS = 7 // CSS pixels around the pointer searched for a splat to pin to
const CLICK_SLOP = 4
const MIN_SCALE = 1e-3

const stem = (filename: string) => filename.replace(/\.(compressed\.ply|ply|sog|json)$/i, '')
const round = (n: number, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits

const SECTION_COLOR = { keep: [0.35, 0.85, 1], cut: [1, 0.5, 0.3] }
const FORCE_COLOR = [0.85, 0.5, 1]

// the 12 edges of a unit cube, as index pairs into its 8 corners
const BOX_CORNERS = [-0.5, 0.5].flatMap((x) => [-0.5, 0.5].flatMap((y) => [-0.5, 0.5].map((z) => new Vec3(x, y, z))))
const BOX_EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7]

/**
 * Editor model: one splat, its per-gaussian edit state, the scene that will be exported
 * next to it (camera, views, section boxes, forces, callouts), and the tools that change
 * them. It owns no panels; the UI listens to `events` and calls methods.
 */
export class Editor {
  readonly viewer: SplatViewer
  readonly events = new Emitter<EditorEvents>()
  readonly history = new History()
  readonly selection: SelectionTools
  readonly callouts: AnnotationLayer
  readonly frames: SectionFrameLayer
  doc: Doc | null = null
  settings = defaultSettings()
  tool: Tool = 'navigate'
  showGrid = true
  /** The section box or force the gizmo tools act on; null = the splat itself */
  active: ActiveObject | null = null
  activeAnnotation: number | null = null
  /** Run the scene's forces in the viewport. They rest while a selection tool is in use. */
  flowPreview = true

  private readonly gizmos: Record<(typeof GIZMO_TOOLS)[number], TransformGizmo>
  private gizmoStart: Transform | null = null
  private gridLines: { positions: number[]; colors: number[] } | null = null
  private sectionNodes: Entity[] = []
  private forceNodes: Entity[] = []
  /** Scene data as it was when a drag began, so the whole drag is one undo step */
  private sceneBefore: string | null = null
  /** Reports whether a world point is hidden by the section boxes */
  private culled: ((x: number, y: number, z: number) => boolean) | null = null
  private helpersHidden = false
  private pressed: { x: number; y: number } | null = null

  static async create(canvas: HTMLCanvasElement, overlay: HTMLCanvasElement, device: DeviceType = 'webgl2') {
    const viewer = await SplatViewer.create(canvas, { device, componentSystems: [RenderComponentSystem] })
    return new Editor(viewer, overlay)
  }

  private constructor(viewer: SplatViewer, overlay: HTMLCanvasElement) {
    this.viewer = viewer
    const { app, controls, camera, canvas } = viewer
    this.history.onChange = () => this.events.emit('history')

    // an editor camera should go anywhere; the limits in `settings` only bind the player
    controls.limits.minDistance = 0.01
    controls.limits.maxDistance = 10_000

    this.selection = new SelectionTools(canvas, overlay)
    this.selection.onSelect = (test, mode) => this.selectOnScreen(test, mode)

    // the same callout layer the player uses, stacked over the selection overlay
    this.callouts = new AnnotationLayer(overlay.parentNode!, camera, canvas, overlay.nextSibling)
    this.frames = new SectionFrameLayer(overlay.parentNode!, camera, canvas, this.callouts.root)
    this.callouts.handlers = {
      onSelect: (index) => this.setActiveAnnotation(index),
      onDragStart: () => this.beginSceneEdit(),
      onDragEnd: () => this.endSceneEdit('Move label'),
      onLabelMove: (index, offset) => {
        this.settings.annotations[index].offset = offset
        this.callouts.update()
      },
      onAnchorMove: (index, clientX, clientY) => {
        const point = this.pickPoint(clientX, clientY)
        if (!point) return
        this.settings.annotations[index].position = tupleOf(point)
        this.callouts.update()
      },
    }

    const layer = Gizmo.createLayer(app)
    this.gizmos = {
      move: new TranslateGizmo(camera.camera!, layer),
      rotate: new RotateGizmo(camera.camera!, layer),
      scale: new ScaleGizmo(camera.camera!, layer),
    }
    // a box or a force turned inside out would be meaningless
    ;(this.gizmos.scale as ScaleGizmo).lowerBoundScale.set(MIN_SCALE, MIN_SCALE, MIN_SCALE)
    for (const gizmo of Object.values(this.gizmos)) {
      // handles answer to the left button only; the others stay with the camera
      gizmo.mouseButtons[1] = false
      gizmo.mouseButtons[2] = false
      gizmo.on('transform:start', () => {
        // the press landed on a handle, so it is neither an orbit nor a click
        controls.cancel()
        this.pressed = null
        if (this.active) this.beginSceneEdit()
        else this.gizmoStart = this.getTransform()
      })
      gizmo.on('transform:move', () => {
        viewer.requestRender()
        if (this.active) this.readActiveNode()
        else this.events.emit('transform')
      })
      gizmo.on('transform:end', () => {
        if (this.active) {
          this.endSceneEdit(this.active.kind === 'section' ? 'Move section box' : 'Move force')
        } else if (this.gizmoStart) {
          this.recordTransform(this.gizmoStart, this.getTransform()!)
        }
        this.gizmoStart = null
      })
      gizmo.on('render:update', () => viewer.requestRender())
    }

    // the label tool pins a callout where the splat is clicked; a drag still orbits
    canvas.addEventListener('pointerdown', (e) => {
      this.pressed = this.tool === 'annotate' && e.button === 0 ? { x: e.clientX, y: e.clientY } : null
    })
    canvas.addEventListener('pointerup', (e) => {
      const pressed = this.pressed
      this.pressed = null
      if (pressed && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) <= CLICK_SLOP) this.addAnnotationAt(e.clientX, e.clientY)
    })

    viewer.events.on('update', (dt) => {
      if (this.doc?.effects.advance(dt)) viewer.requestRender()
      this.callouts.update()
      this.frames.update()
    })
    app.on('prerender', () => this.drawHelpers())
    this.applyTool()
  }

  destroy() {
    this.selection.destroy()
    this.callouts.destroy()
    this.frames.destroy()
    for (const gizmo of Object.values(this.gizmos)) gizmo.destroy()
    this.events.clear()
    this.viewer.destroy()
  }

  // ── documents ────────────────────────────────────────────────────────────

  /**
   * Open a splat, replacing the current one. With `scene`, its transform and settings are
   * restored too (reopening an exported scene together with its splat file).
   */
  async open(input: SplatInput, scene?: SplatScene) {
    const label = 'file' in input ? input.file.name : input.url
    this.events.emit('busy', `Loading ${label.split('/').pop()}…`)
    try {
      const source = scene?.splats[0]
      const splat = await this.viewer.addSplat(
        input,
        { position: source?.position, rotation: source?.rotation ?? DEFAULT_ROTATION, scale: source?.scale },
        // keep full-precision data in memory (so it can be exported) and declare the edit stream
        { data: { decompress: true }, prepare: (resource) => SplatState.declare(resource) },
      )
      // only now is it safe to drop the previous splat: a failed load leaves the old one open
      this.close(false)

      const component = splat.entity.gsplat!
      const effects = new SplatEffects(component, { editState: true })
      const state = new SplatState(splat.resource, component, effects)
      this.doc = { splat, state, effects, name: stem(splat.filename) }
      this.history.clear()
      this.settings = defaultSettings()
      if (scene) this.applyScene(scene)

      this.viewer.setFov(this.settings.fov)
      this.viewer.setBackground(this.settings.background)
      if (this.settings.initial) this.viewer.controls.setPose(this.settings.initial)
      else this.viewer.frameScene()

      this.applyTool()
      this.syncScene()
      this.events.emit('doc')
      this.events.emit('settings')
      this.events.emit('selection')
      this.events.emit('transform')
      this.events.emit('notice', `Opened ${splat.filename}: ${state.count.toLocaleString()} splats`)
    } finally {
      this.events.emit('busy', null)
    }
  }

  close(notify = true) {
    if (!this.doc) return
    for (const gizmo of Object.values(this.gizmos)) gizmo.detach()
    this.viewer.removeSplat(this.doc.splat)
    this.doc = null
    this.history.clear()
    this.settings = defaultSettings()
    this.active = null
    this.activeAnnotation = null
    this.syncScene()
    if (notify) {
      this.events.emit('doc')
      this.events.emit('selection')
    }
  }

  private applyScene(scene: SplatScene) {
    const s = this.settings
    s.fov = scene.camera?.fov ?? s.fov
    s.initial = scene.camera?.initial ?? null
    s.poses = (scene.poses ?? []).map((p) => ({ ...p }))
    s.background = scene.background === undefined ? s.background : scene.background
    for (const key of Object.keys(s.controls) as (keyof ControlLimits)[]) {
      const value = scene.controls?.[key]
      if (value !== undefined) (s.controls[key] as number | boolean) = value
    }
    // deep copies: the editor mutates these in place
    const copy = <T>(list: T[] | undefined): T[] => JSON.parse(JSON.stringify(list ?? []))
    s.sections = copy(scene.sections)
    s.sectionRest = scene.sectionRest ? { ...scene.sectionRest } : { opacity: DEFAULT_REST_OPACITY, hidden: true }
    s.annotations = copy(scene.annotations)
    s.forces = copy(scene.forces)
  }

  // ── tools ────────────────────────────────────────────────────────────────

  setTool(tool: Tool) {
    if (this.tool === tool) return
    this.tool = tool
    this.applyTool()
    this.events.emit('tool', tool)
  }

  private applyTool() {
    const { tool } = this
    const { controls } = this.viewer
    this.selection.setTool(isSelectTool(tool) && this.doc ? tool : null)
    // callouts can only be grabbed with the label tool, so they never get in the way of an orbit
    this.callouts.editable = tool === 'annotate'

    // while selecting, the left button draws; the camera moves to Alt+left, right and middle
    controls.dragFilter = isSelectTool(tool)
      ? (e) => (e.button === 0 ? (e.altKey ? 'orbit' : null) : e.button === 2 ? 'orbit' : e.button === 1 ? 'pan' : null)
      : (e) => (e.button === 0 ? (e.shiftKey ? 'pan' : 'orbit') : e.button === 1 || e.button === 2 ? 'pan' : null)

    this.attachGizmo()
    // selection reads splats where they rest, so a running flow would mislead it
    this.applyForces()
    this.viewer.requestRender(2)
  }

  /** What the gizmo tools currently move */
  private get gizmoNode(): Entity | null {
    if (!this.doc) return null
    if (!this.active) return this.doc.splat.entity
    return (this.active.kind === 'section' ? this.sectionNodes : this.forceNodes)[this.active.index] ?? null
  }

  private attachGizmo() {
    const node = this.gizmoNode
    for (const [name, gizmo] of Object.entries(this.gizmos)) {
      if (name === this.tool && node) gizmo.attach(node)
      else gizmo.detach()
    }
  }

  // ── selection ────────────────────────────────────────────────────────────

  /**
   * Run `mutate` on the flags and record the difference as one undo step.
   * Returns false when nothing changed.
   */
  private editFlags(label: string, mutate: (flags: Uint8Array) => void): boolean {
    const doc = this.doc
    if (!doc) return false
    const { state } = doc
    const before = state.flags.slice()
    mutate(state.flags)
    const diff = diffBytes(before, state.flags)
    if (!diff) return false

    const apply = (values: Uint8Array) => {
      for (let i = 0; i < diff.indices.length; i++) state.flags[diff.indices[i]] = values[i]
      state.commit()
      this.viewer.requestRender(2)
      this.events.emit('selection')
    }
    state.commit()
    this.viewer.requestRender(2)
    this.history.push({ label, undo: () => apply(diff.from), redo: () => apply(diff.to) })
    this.events.emit('selection')
    return true
  }

  /**
   * Whether splat `i` cannot be touched: deleted, or hidden by a section box. Selection
   * only ever acts on what is visible, so a box can also serve as a mask while cleaning up.
   */
  private untouchable(): (index: number, flags: Uint8Array) => boolean {
    const doc = this.doc
    const culled = this.culled
    if (!doc || !culled || !doc.splat.resource.hasCenters) return (i, flags) => (flags[i] & DELETED) !== 0
    const centers = doc.splat.resource.centers
    const w = doc.splat.entity.getWorldTransform().data
    return (i, flags) => {
      if (flags[i] & DELETED) return true
      const o = i * 3
      const x = centers[o]
      const y = centers[o + 1]
      const z = centers[o + 2]
      return culled(w[0] * x + w[4] * y + w[8] * z + w[12], w[1] * x + w[5] * y + w[9] * z + w[13], w[2] * x + w[6] * y + w[10] * z + w[14])
    }
  }

  /** Select the splats whose centers project inside a shape drawn on screen. */
  private selectOnScreen(test: ScreenTest, mode: SelectMode) {
    const doc = this.doc
    if (!doc) return
    const { resource, entity } = doc.splat
    if (!resource.hasCenters) {
      this.events.emit('notice', 'This splat has no per-splat positions to select by')
      return
    }
    const centers = resource.centers
    const camera = this.viewer.camera.camera!
    const mvp = new Mat4().mul2(camera.projectionMatrix, camera.viewMatrix).mul(entity.getWorldTransform())
    const m = mvp.data
    const width = this.viewer.canvas.clientWidth
    const height = this.viewer.canvas.clientHeight
    const skip = this.untouchable()

    this.editFlags(mode === 'remove' ? 'Deselect' : 'Select', (flags) => {
      for (let i = 0, o = 0; i < flags.length; i++, o += 3) {
        if (skip(i, flags)) continue
        const x = centers[o]
        const y = centers[o + 1]
        const z = centers[o + 2]
        const w = m[3] * x + m[7] * y + m[11] * z + m[15]
        let hit = false
        // w <= 0 is behind the camera
        if (w > 0) {
          const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w) * 0.5 + 0.5
          const sy = 0.5 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * 0.5
          hit = sx >= 0 && sx <= 1 && sy >= 0 && sy <= 1 && test(sx * width, sy * height)
        }
        if (mode === 'set') flags[i] = hit ? SELECTED : 0
        else if (hit) flags[i] = mode === 'add' ? SELECTED : 0
      }
    })
  }

  selectAll() {
    const skip = this.untouchable()
    this.editFlags('Select all', (flags) => {
      for (let i = 0; i < flags.length; i++) if (!skip(i, flags)) flags[i] = SELECTED
    })
  }

  selectNone() {
    this.editFlags('Deselect all', (flags) => {
      for (let i = 0; i < flags.length; i++) if (!(flags[i] & DELETED)) flags[i] = 0
    })
  }

  invertSelection() {
    const skip = this.untouchable()
    this.editFlags('Invert selection', (flags) => {
      for (let i = 0; i < flags.length; i++) if (!skip(i, flags)) flags[i] ^= SELECTED
    })
  }

  deleteSelected() {
    const count = this.doc?.state.selected ?? 0
    if (count === 0) return
    this.editFlags('Delete', (flags) => {
      for (let i = 0; i < flags.length; i++) if (flags[i] & SELECTED) flags[i] = DELETED
    })
    this.events.emit('notice', `Deleted ${count.toLocaleString()} splats`)
  }

  /** Delete everything visible except the selection. */
  keepSelected() {
    const state = this.doc?.state
    if (!state || state.selected === 0) return
    const skip = this.untouchable()
    const before = state.deleted
    this.editFlags('Keep selection', (flags) => {
      for (let i = 0; i < flags.length; i++) if (!skip(i, flags)) flags[i] = flags[i] & SELECTED ? 0 : DELETED
    })
    this.events.emit('notice', `Deleted ${(state.deleted - before).toLocaleString()} splats`)
  }

  /** Per-splat opacity (0..1) is only at hand for uncompressed data; SOG keeps it quantized on the GPU. */
  get canSelectByOpacity() {
    return this.opacities() !== null
  }

  private opacities(): { values: Float32Array; activated: boolean } | null {
    const data = this.doc?.splat.resource.gsplatData as GSplatData | undefined
    const values = typeof data?.getProp === 'function' ? data.getProp('opacity') : null
    return values instanceof Float32Array ? { values, activated: data!.activated === true } : null
  }

  /** Select faint splats: the haze of low-opacity floaters around most captures. */
  selectFaint(maxOpacity: number) {
    const opacity = this.opacities()
    if (!opacity) return
    const { values, activated } = opacity
    // .ply stores opacity before the sigmoid; compare in that space instead of converting every splat
    const limit = activated ? maxOpacity : Math.log(maxOpacity / (1 - maxOpacity))
    const skip = this.untouchable()
    this.editFlags('Select faint', (flags) => {
      for (let i = 0; i < flags.length; i++) if (!skip(i, flags)) flags[i] = values[i] <= limit ? SELECTED : 0
    })
  }

  /** Select everything farther than `radius` world units from the orbit target. */
  selectOutside(radius: number) {
    const doc = this.doc
    if (!doc || !doc.splat.resource.hasCenters) return
    const centers = doc.splat.resource.centers
    // measure in the splat's own space: one matrix inverse instead of a transform per splat
    const world = doc.splat.entity.getWorldTransform()
    const local = new Mat4().copy(world).invert().transformPoint(this.viewer.controls.target)
    const scale = world.getScale()
    const r = radius / Math.max((scale.x + scale.y + scale.z) / 3, 1e-6)
    const r2 = r * r
    const skip = this.untouchable()
    this.editFlags('Select outside radius', (flags) => {
      for (let i = 0, o = 0; i < flags.length; i++, o += 3) {
        if (skip(i, flags)) continue
        const dx = centers[o] - local.x
        const dy = centers[o + 1] - local.y
        const dz = centers[o + 2] - local.z
        flags[i] = dx * dx + dy * dy + dz * dz > r2 ? SELECTED : 0
      }
    })
  }

  /**
   * The point on the splat under a screen position (client coordinates), or null over empty
   * space. Splats have no surface to hit, so this takes the splats whose centers fall within
   * a few pixels of the pointer and settles on the nearest dense depth, ignoring the odd
   * stray splat hanging in front.
   */
  pickPoint(clientX: number, clientY: number): Vec3 | null {
    const doc = this.doc
    if (!doc || !doc.splat.resource.hasCenters) return null
    const rect = this.viewer.canvas.getBoundingClientRect()
    const px = clientX - rect.left
    const py = clientY - rect.top
    const centers = doc.splat.resource.centers
    const { flags } = doc.state
    const world = doc.splat.entity.getWorldTransform()
    const camera = this.viewer.camera.camera!
    const m = new Mat4().mul2(camera.projectionMatrix, camera.viewMatrix).mul(world).data
    const skip = this.untouchable()

    const hits: { index: number; depth: number; distance: number }[] = []
    for (let i = 0, o = 0; i < flags.length; i++, o += 3) {
      const x = centers[o]
      const y = centers[o + 1]
      const z = centers[o + 2]
      const w = m[3] * x + m[7] * y + m[11] * z + m[15]
      if (w <= 0) continue
      const dx = (((m[0] * x + m[4] * y + m[8] * z + m[12]) / w) * 0.5 + 0.5) * rect.width - px
      if (dx > PICK_RADIUS || dx < -PICK_RADIUS) continue
      const dy = (0.5 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * 0.5) * rect.height - py
      if (dy > PICK_RADIUS || dy < -PICK_RADIUS || skip(i, flags)) continue
      hits.push({ index: i, depth: w, distance: dx * dx + dy * dy })
    }
    if (hits.length === 0) return null

    hits.sort((a, b) => a.depth - b.depth)
    // a little way into the pile rather than its very front
    const surface = hits[Math.floor(hits.length * 0.15)].depth
    let best = hits[0]
    let bestScore = Infinity
    for (const hit of hits) {
      if (Math.abs(hit.depth - surface) > surface * 0.03) continue
      if (hit.distance < bestScore) {
        best = hit
        bestScore = hit.distance
      }
    }
    const o = best.index * 3
    return world.transformPoint(new Vec3(centers[o], centers[o + 1], centers[o + 2]))
  }

  // ── transform ────────────────────────────────────────────────────────────

  getTransform(): Transform | null {
    const entity = this.doc?.splat.entity
    if (!entity) return null
    return {
      position: tupleOf(entity.getLocalPosition()),
      rotation: tupleOf(entity.getLocalEulerAngles()),
      scale: tupleOf(entity.getLocalScale()),
    }
  }

  /** Set the splat's transform as one undo step. */
  setTransform(next: Transform) {
    const before = this.getTransform()
    if (!before) return
    this.applyTransform(this.doc!.splat.entity, next)
    this.recordTransform(before, next)
  }

  private applyTransform(entity: Entity, t: Transform) {
    entity.setLocalPosition(...t.position)
    entity.setLocalEulerAngles(...t.rotation)
    entity.setLocalScale(...t.scale)
    // a gizmo caches where its node was; re-attach so it follows
    this.attachGizmo()
    this.viewer.requestRender(2)
    this.events.emit('transform')
  }

  private recordTransform(before: Transform, after: Transform) {
    if (JSON.stringify(before) === JSON.stringify(after)) return
    const entity = this.doc!.splat.entity
    this.history.push({
      label: 'Transform',
      undo: () => this.applyTransform(entity, before),
      redo: () => this.applyTransform(entity, after),
    })
  }

  // ── scene settings ───────────────────────────────────────────────────────

  updateSettings(patch: Partial<Omit<SceneSettings, 'controls' | 'sections' | 'annotations' | 'forces'>> & { controls?: Partial<ControlLimits> }) {
    const { controls, ...rest } = patch
    Object.assign(this.settings, rest)
    if (controls) Object.assign(this.settings.controls, controls)
    if (patch.fov !== undefined) this.viewer.setFov(patch.fov)
    if (patch.background !== undefined) this.viewer.setBackground(patch.background)
    this.events.emit('settings')
  }

  /** Use the current camera as the view the player opens with. */
  setInitialFromCamera() {
    this.updateSettings({ initial: this.viewer.controls.getPose() })
    this.events.emit('notice', 'Start view set to the current camera')
  }

  addPose(name?: string) {
    const poses = [...this.settings.poses, { ...this.viewer.controls.getPose(), name: name ?? `View ${this.settings.poses.length + 1}` }]
    this.updateSettings({ poses })
  }

  updatePose(index: number, patch: Partial<CameraPose> | 'camera') {
    const poses = this.settings.poses.map((pose, i) =>
      i !== index ? pose : patch === 'camera' ? { ...this.viewer.controls.getPose(), name: pose.name } : { ...pose, ...patch },
    )
    this.updateSettings({ poses })
  }

  removePose(index: number) {
    this.updateSettings({ poses: this.settings.poses.filter((_, i) => i !== index) })
  }

  goToPose(pose: CameraPose) {
    this.viewer.controls.setPose(pose, true)
    this.viewer.requestRender()
  }

  frame() {
    this.viewer.frameScene(true)
  }

  // ── scene objects: undo and syncing ──────────────────────────────────────

  private snapshotScene() {
    const { sections, sectionRest, annotations, forces } = this.settings
    return JSON.stringify({ sections, sectionRest, annotations, forces })
  }

  private restoreScene(snapshot: string) {
    Object.assign(this.settings, JSON.parse(snapshot))
    this.syncScene()
  }

  /** Change section boxes, forces or callouts as one undo step. */
  private editScene(label: string, mutate: () => void) {
    const before = this.snapshotScene()
    mutate()
    this.commitScene(label, before)
  }

  private commitScene(label: string, before: string) {
    const after = this.snapshotScene()
    this.syncScene()
    if (after === before) return
    this.history.push({ label, undo: () => this.restoreScene(before), redo: () => this.restoreScene(after) })
  }

  /** A drag (gizmo, callout) is starting: everything until `endSceneEdit` is one undo step. */
  private beginSceneEdit() {
    this.sceneBefore ??= this.snapshotScene()
  }

  private endSceneEdit(label: string) {
    const before = this.sceneBefore
    this.sceneBefore = null
    if (before !== null) this.commitScene(label, before)
  }

  /** Bring the helper nodes, the splat's effects and the callout layer in line with `settings`. */
  private syncScene() {
    const { sections, annotations, forces } = this.settings
    const fit = (nodes: Entity[], count: number, name: string) => {
      while (nodes.length > count) nodes.pop()!.destroy()
      while (nodes.length < count) {
        const node = new Entity(name, this.viewer.app)
        this.viewer.app.root.addChild(node)
        nodes.push(node)
      }
    }
    fit(this.sectionNodes, sections.length, 'section')
    fit(this.forceNodes, forces.length, 'force')
    sections.forEach((s, i) => {
      this.sectionNodes[i].setLocalPosition(...s.position)
      this.sectionNodes[i].setLocalEulerAngles(...s.rotation)
      this.sectionNodes[i].setLocalScale(...s.size)
    })
    forces.forEach((f, i) => {
      this.forceNodes[i].setLocalPosition(...f.position)
      this.forceNodes[i].setLocalEulerAngles(...(f.rotation ?? [0, 0, 0]))
      this.forceNodes[i].setLocalScale(f.radius, f.radius, f.radius)
    })

    const list = this.active ? (this.active.kind === 'section' ? sections : forces) : null
    if (this.active && this.active.index >= list!.length) this.active = null
    if (this.activeAnnotation !== null && this.activeAnnotation >= annotations.length) this.activeAnnotation = null

    this.applySections()
    this.applyForces()
    this.callouts.setSelected(this.activeAnnotation)
    this.attachGizmo()
    this.viewer.requestRender(3)
    this.events.emit('scene')
  }

  private applySections() {
    const { sections, sectionRest, annotations } = this.settings
    const rest = restOpacity(sectionRest)
    this.doc?.effects.setSections(sections, rest)
    // selection and "delete the rest" treat the left-out splats as out of bounds, faded or not
    this.culled = sectionTest(sections)
    // callouts whose point is no longer drawn go with it, exactly as in the player
    this.callouts.set(annotations, rest > 0 ? null : this.culled)
    this.callouts.visible = !!this.doc
    this.frames.set(sections)
    this.frames.visible = !!this.doc
  }

  /** Fade the splats the boxes leave out, or stop drawing them. */
  setSectionRest(patch: Partial<SectionRest>) {
    this.editScene('Change the rest of the splat', () => Object.assign(this.settings.sectionRest, patch))
  }

  /** Slider drags: show the change now, record it once when the drag ends. */
  previewSectionRest(opacity: number) {
    this.beginSceneEdit()
    this.settings.sectionRest.opacity = opacity
    this.applySections()
    this.viewer.requestRender(2)
  }

  commitSectionRest() {
    this.endSceneEdit('Fade the rest of the splat')
  }

  private applyForces() {
    const live = this.flowPreview && !isSelectTool(this.tool)
    this.doc?.effects.setForces(live ? this.settings.forces : [])
    this.viewer.requestRender(2)
  }

  setFlowPreview(on: boolean) {
    this.flowPreview = on
    this.applyForces()
    this.events.emit('scene')
  }

  /** Point the gizmo tools at a section box or a force; null returns them to the splat. */
  setActive(active: ActiveObject | null) {
    this.active = active
    this.attachGizmo()
    this.viewer.requestRender(2)
    this.events.emit('scene')
    if (active && !isGizmoTool(this.tool)) this.setTool('move')
  }

  /** The gizmo moved the active box or force: copy its node back into the scene data. */
  private readActiveNode() {
    const active = this.active
    if (!active) return
    if (active.kind === 'section') {
      const node = this.sectionNodes[active.index]
      const box = this.settings.sections[active.index]
      box.position = tupleOf(node.getLocalPosition())
      box.rotation = tupleOf(node.getLocalEulerAngles())
      box.size = tupleOf(node.getLocalScale())
      this.applySections()
    } else {
      const node = this.forceNodes[active.index]
      const force = this.settings.forces[active.index]
      force.position = tupleOf(node.getLocalPosition())
      force.rotation = tupleOf(node.getLocalEulerAngles())
      // a force's reach is one number: follow whichever axis handle is being pulled
      const scale = node.getLocalScale()
      const moved = [scale.x, scale.y, scale.z].reduce((a, b) => (Math.abs(b - force.radius) > Math.abs(a - force.radius) ? b : a))
      force.radius = round(Math.max(moved, MIN_SCALE))
      this.applyForces()
    }
    this.events.emit('scene')
  }

  // ── section boxes ────────────────────────────────────────────────────────

  addSection(mode: 'keep' | 'cut' = 'keep') {
    const { sections } = this.settings
    if (!this.doc) return
    if (sections.length >= MAX_SECTIONS) return this.events.emit('notice', `A scene can hold up to ${MAX_SECTIONS} section boxes`)
    const focus = this.viewer.getFocus()
    const center = focus?.center ?? new Vec3()
    const r = focus?.radius ?? 1
    const position = tupleOf(center)
    let size: Vec3Tuple
    if (mode === 'cut') {
      size = [round(r * 0.6), round(r * 0.6), round(r * 0.6)]
    } else {
      // start as a box that already slices: it drops the half nearest the camera, so the cut
      // face looks back at you instead of a box that changes nothing until it is moved
      size = [round(r * 2.4), round(r * 2.4), round(r * 2.4)]
      const pose = this.viewer.controls.getPose()
      const dx = pose.target[0] - pose.position[0]
      const dz = pose.target[2] - pose.position[2]
      const axis = Math.abs(dx) > Math.abs(dz) ? 0 : 2
      position[axis] = round(position[axis] + (Math.sign(axis === 0 ? dx : dz) || 1) * (size[axis] / 2))
    }
    const name = `${mode === 'cut' ? 'Cut' : 'Section'} ${sections.filter((s) => (s.mode ?? 'keep') === mode).length + 1}`
    this.editScene('Add section box', () => {
      sections.push({ name, position, rotation: [0, 0, 0], size, mode, enabled: true })
      this.active = { kind: 'section', index: sections.length - 1 }
    })
    if (!isGizmoTool(this.tool)) this.setTool('move')
  }

  updateSection(index: number, patch: Partial<SectionBox>) {
    this.editScene('Edit section box', () => Object.assign(this.settings.sections[index], patch))
  }

  removeSection(index: number) {
    this.editScene('Remove section box', () => {
      this.settings.sections.splice(index, 1)
      if (this.active?.kind === 'section') this.active = null
    })
  }

  /** Make the cut permanent: delete every splat the section boxes currently hide. */
  bakeSections() {
    const doc = this.doc
    const culled = this.culled
    if (!doc || !culled || !doc.splat.resource.hasCenters) return
    const hidden = this.untouchable()
    const before = doc.state.deleted
    this.editFlags('Delete the rest', (flags) => {
      for (let i = 0; i < flags.length; i++) if (!(flags[i] & DELETED) && hidden(i, flags)) flags[i] = DELETED
    })
    this.events.emit('notice', `Deleted ${(doc.state.deleted - before).toLocaleString()} splats outside the section boxes`)
  }

  // ── forces ───────────────────────────────────────────────────────────────

  addForce(type: ForceType = 'swirl') {
    const { forces } = this.settings
    if (!this.doc) return
    if (forces.length >= MAX_FORCES) return this.events.emit('notice', `A scene can hold up to ${MAX_FORCES} forces`)
    const focus = this.viewer.getFocus()
    const r = focus?.radius ?? 1
    // sized to the splat, so a force does something visible on a tabletop object and a hall alike
    const force: Force = {
      name: `${type[0].toUpperCase()}${type.slice(1)} ${forces.filter((f) => f.type === type).length + 1}`,
      type,
      position: tupleOf(focus?.center ?? new Vec3()),
      rotation: [0, 0, 0],
      radius: round(r * 0.9),
      strength: type === 'swirl' ? 50 : type === 'attract' ? 0.25 : round(r * 0.1),
      amount: FORCE_DEFAULTS.amount,
      cycle: FORCE_DEFAULTS.cycle,
      render: 'splats',
      // ready for when the force is switched to points: sized to the splat like everything else
      dotSize: round(r * 0.006, 4),
      color: FORCE_DEFAULTS.color,
      tint: FORCE_DEFAULTS.tint,
      noise: round(r * 0.03),
      noiseScale: round(r * 0.5),
      lift: type === 'swirl' ? round(r * 0.05) : 0,
      pull: 0,
      enabled: true,
    }
    this.editScene('Add force', () => {
      forces.push(force)
      this.active = { kind: 'force', index: forces.length - 1 }
    })
    if (!isGizmoTool(this.tool)) this.setTool('move')
  }

  updateForce(index: number, patch: Partial<Force>) {
    this.editScene('Edit force', () => Object.assign(this.settings.forces[index], patch))
  }

  removeForce(index: number) {
    this.editScene('Remove force', () => {
      this.settings.forces.splice(index, 1)
      if (this.active?.kind === 'force') this.active = null
    })
  }

  // ── callouts ─────────────────────────────────────────────────────────────

  private addAnnotationAt(clientX: number, clientY: number) {
    const point = this.pickPoint(clientX, clientY)
    if (!point) return this.events.emit('notice', 'Click on the splat to pin a label there')
    const { annotations } = this.settings
    this.editScene('Add label', () => {
      annotations.push({ title: `Label ${annotations.length + 1}`, text: '', position: tupleOf(point), offset: [...DEFAULT_ANNOTATION_OFFSET] })
      this.activeAnnotation = annotations.length - 1
    })
  }

  updateAnnotation(index: number, patch: Partial<Annotation>) {
    this.editScene('Edit label', () => Object.assign(this.settings.annotations[index], patch))
  }

  removeAnnotation(index: number) {
    this.editScene('Remove label', () => {
      this.settings.annotations.splice(index, 1)
      this.activeAnnotation = null
    })
  }

  setActiveAnnotation(index: number | null) {
    if (this.activeAnnotation === index) return
    this.activeAnnotation = index
    this.callouts.setSelected(index)
    this.events.emit('scene')
  }

  /** Orbit around a callout's point, keeping the current viewing direction and distance. */
  lookAtAnnotation(index: number) {
    const annotation = this.settings.annotations[index]
    if (!annotation) return
    const pose = this.viewer.controls.getPose()
    const [tx, ty, tz] = annotation.position
    this.goToPose({
      target: annotation.position,
      position: [tx + pose.position[0] - pose.target[0], ty + pose.position[1] - pose.target[1], tz + pose.position[2] - pose.target[2]],
    })
  }

  // ── export ───────────────────────────────────────────────────────────────

  /** The scene file for the player. `splatSrc` is the splat's URL relative to where the scene file will live. */
  buildScene(splatSrc: string): SplatScene {
    const doc = this.doc
    if (!doc) throw new Error('Nothing to export')
    const t = this.getTransform()!
    const s = this.settings
    const scene: SplatScene = {
      version: 1,
      name: doc.name,
      splats: [{ src: splatSrc, position: t.position, rotation: t.rotation, scale: t.scale }],
      camera: { fov: s.fov, initial: s.initial ?? this.viewer.controls.getPose() },
      poses: s.poses,
      controls: { ...s.controls },
      background: s.background,
    }
    // left out when empty, so a plain scene stays a short file
    const copy = <T>(list: T[]): T[] => JSON.parse(JSON.stringify(list))
    if (s.sections.length) {
      scene.sections = copy(s.sections)
      scene.sectionRest = { ...s.sectionRest }
    }
    if (s.annotations.length) scene.annotations = copy(s.annotations)
    if (s.forces.length) scene.forces = copy(s.forces)
    return scene
  }

  /** The edited splat as a .ply, without the deleted gaussians. */
  async buildPly() {
    const doc = this.doc
    if (!doc) throw new Error('Nothing to export')
    this.events.emit('busy', 'Writing .ply…')
    try {
      const { flags } = doc.state
      return await exportPly(doc.splat.resource, (i) => !(flags[i] & DELETED))
    } finally {
      this.events.emit('busy', null)
    }
  }

  /** A still of the current view with the editor's helpers hidden: the player's poster image. */
  async capturePoster() {
    const doc = this.doc
    if (!doc) throw new Error('Nothing to capture')
    const { flags } = doc.state
    // the poster must look like the player's first frame: no grid, boxes, gizmo or selection tint
    const selected: number[] = []
    for (let i = 0; i < flags.length; i++) if (flags[i] & SELECTED) selected.push(i)
    for (const i of selected) flags[i] = 0
    if (selected.length) doc.state.commit()
    this.helpersHidden = true
    for (const gizmo of Object.values(this.gizmos)) gizmo.detach()
    try {
      // the tint is removed in the work buffer, which lags the flags by a frame
      this.viewer.app.render()
      return await this.viewer.capture('image/webp', 0.9)
    } finally {
      for (const i of selected) flags[i] = SELECTED
      if (selected.length) doc.state.commit()
      this.helpersHidden = false
      this.attachGizmo()
      this.viewer.requestRender(2)
    }
  }

  // ── helpers drawn in the viewport ────────────────────────────────────────

  setGrid(show: boolean) {
    this.showGrid = show
    this.viewer.requestRender()
  }

  /** Immediate-mode lines last one frame, so everything here is queued again before every render. */
  private drawHelpers() {
    if (this.helpersHidden) return
    const { app } = this.viewer
    if (this.showGrid) {
      if (!this.gridLines) {
        const positions: number[] = []
        const colors: number[] = []
        const line = (ax: number, az: number, bx: number, bz: number, c: number[]) => {
          positions.push(ax, 0, az, bx, 0, bz)
          colors.push(...c, ...c)
        }
        for (let i = -GRID_EXTENT; i <= GRID_EXTENT; i++) {
          const minor = [0.5, 0.5, 0.5, i % 5 === 0 ? 0.5 : 0.22]
          line(i, -GRID_EXTENT, i, GRID_EXTENT, i === 0 ? [0.25, 0.45, 1, 0.9] : minor)
          line(-GRID_EXTENT, i, GRID_EXTENT, i, i === 0 ? [1, 0.3, 0.3, 0.9] : minor)
        }
        this.gridLines = { positions, colors }
      }
      // the grid goes in the World layer, whose opaque pass runs before the splats, so the splat covers it
      const world = app.scene.layers.getLayerByName('World') ?? undefined
      app.drawLineArrays(this.gridLines.positions, this.gridLines.colors, true, world)
    }

    const { sections, forces } = this.settings
    if (sections.length === 0 && forces.length === 0) return
    const positions: number[] = []
    const colors: number[] = []
    const segment = (a: Vec3, b: Vec3, color: number[], alpha: number) => {
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z)
      colors.push(...color, alpha, ...color, alpha)
    }
    const a = new Vec3()
    const b = new Vec3()

    sections.forEach((box, i) => {
      const matrix = this.sectionNodes[i]?.getWorldTransform()
      if (!matrix) return
      const active = this.active?.kind === 'section' && this.active.index === i
      const alpha = box.enabled === false ? 0.2 : active ? 1 : 0.5
      const corners = BOX_CORNERS.map((corner) => matrix.transformPoint(corner))
      for (let e = 0; e < BOX_EDGES.length; e += 2) segment(corners[BOX_EDGES[e]], corners[BOX_EDGES[e + 1]], SECTION_COLOR[box.mode ?? 'keep'], alpha)
    })

    forces.forEach((force, i) => {
      const node = this.forceNodes[i]
      if (!node) return
      const active = this.active?.kind === 'force' && this.active.index === i
      const alpha = force.enabled === false ? 0.2 : active ? 1 : 0.5
      const center = node.getPosition()
      const axes = [node.right, node.up, node.forward]
      // three great circles mark the force's reach
      for (let c = 0; c < 3; c++) {
        const u = axes[c]
        const v = axes[(c + 1) % 3]
        for (let s = 0; s < CIRCLE_STEPS; s++) {
          const t0 = (s / CIRCLE_STEPS) * Math.PI * 2
          const t1 = ((s + 1) / CIRCLE_STEPS) * Math.PI * 2
          a.copy(center).add(b.copy(u).mulScalar(Math.cos(t0) * force.radius)).add(b.copy(v).mulScalar(Math.sin(t0) * force.radius))
          const end = new Vec3().copy(center).add(b.copy(u).mulScalar(Math.cos(t1) * force.radius)).add(b.copy(v).mulScalar(Math.sin(t1) * force.radius))
          segment(a.clone(), end, FORCE_COLOR, alpha * 0.7)
        }
      }
      // and a spine shows which way it swirls or blows
      if (force.type === 'swirl' || force.type === 'wind') {
        const up = node.up
        segment(new Vec3().copy(center).sub(b.copy(up).mulScalar(force.radius)), new Vec3().copy(center).add(b.copy(up).mulScalar(force.radius * 1.25)), FORCE_COLOR, alpha)
      }
    })
    // drawn over the splat: a box buried inside it would otherwise be impossible to find
    app.drawLineArrays(positions, colors, false)
  }
}
