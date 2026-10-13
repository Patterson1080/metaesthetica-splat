import {
  Entity,
  Gizmo,
  Mat4,
  Quat,
  RenderComponentSystem,
  RotateGizmo,
  ScaleGizmo,
  TranslateGizmo,
  Vec3,
  type GSplatData,
  type TransformGizmo,
} from 'playcanvas'
import { ANIMATABLE, SAME_TIME, constrain, dropTracksFor, evaluate, insertKey, parseTarget, readSceneValue, sampleTarget, targetOf, writeSceneValue, type AnimValue, type TargetRef } from '../core/animation'
import { AnnotationLayer } from '../core/annotations'
import { SectionFrameLayer } from '../core/section-frames'
import { SplatEffects } from '../core/effects'
import { Emitter } from '../core/events'
import {
  DEFAULT_ANNOTATION_OFFSET,
  DEFAULT_BACKGROUND,
  DEFAULT_DURATION,
  DEFAULT_FOV,
  DEFAULT_FPS,
  DEFAULT_REST_OPACITY,
  DEFAULT_ROTATION,
  FORCE_DEFAULTS,
  MAX_FORCES,
  MAX_SECTIONS,
  restOpacity,
  type Animation,
  type Annotation,
  type CameraPose,
  type ControlLimits,
  type Force,
  type ForceType,
  type Keyframe,
  type SectionBox,
  type SectionRest,
  type SplatScene,
  type Vec3Tuple,
} from '../core/scene'
import { sectionTest } from '../core/sections'
import { SplatViewer, nextTask, tupleOf, type DeviceType, type LoadedSplat, type SplatInput } from '../core/viewer'
import { History, diffBytes } from './history'
import { paintLabels } from './label-painter'
import { exportPly } from './ply-export'
import { SelectionTools, type ScreenTest, type SelectMode } from './selection'
import { DELETED, SELECTED, SplatState } from './splat-state'
import { ViewNavigation } from './view-nav'

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
  animation: Animation
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
  animation: { duration: DEFAULT_DURATION, loop: true, tracks: [] },
})

/** The splat being edited. */
export interface Doc {
  splat: LoadedSplat
  state: SplatState
  effects: SplatEffects
  /** File name without its extension, used to name exports */
  name: string
}

/** How a property stands on the timeline at the playhead: what the diamond beside it shows */
export interface KeyState {
  /** It has a track */
  animated: boolean
  /** One of its keys sits at the playhead */
  onKey: boolean
  /** Its value is not what its track says it is here: changed by hand, and not keyed yet */
  changed: boolean
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
  /** Keyframes, tracks or the timeline's switches changed */
  animation: []
  /** The playhead moved, or playback started or stopped */
  time: []
  /** The viewport camera moved, or its projection changed */
  view: []
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

const PROP_LABELS: Record<string, string> = {
  position: 'Position', rotation: 'Rotation', scale: 'Scale', size: 'Size', target: 'Target', fov: 'Field of view',
  radius: 'Reach', strength: 'Strength', amount: 'Share moving', dotSize: 'Point size', tint: 'Tint',
  noise: 'Wander', noiseScale: 'Eddy size', lift: 'Lift', pull: 'Pull in', opacity: 'Opacity',
}

/** Values this close are the same value: a camera pose is rounded on its way in and out */
const SAME_VALUE = 2e-3
const quatA = new Quat()
const quatB = new Quat()

function sameValue(prop: string, a: AnimValue, b: AnimValue): boolean {
  if (typeof a === 'number' || typeof b === 'number') {
    return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= SAME_VALUE * Math.max(1, Math.abs(a), Math.abs(b))
  }
  if (prop === 'rotation') {
    // the same turn can be written as different angles, so compare the turns themselves
    quatA.setFromEulerAngles(a[0], a[1], a[2])
    quatB.setFromEulerAngles(b[0], b[1], b[2])
    const dot = quatA.x * quatB.x + quatA.y * quatB.y + quatA.z * quatB.z + quatA.w * quatB.w
    return 1 - Math.abs(dot) < 1e-6
  }
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= SAME_VALUE * Math.max(1, Math.abs(v), Math.abs(b[i])))
}

// A view is a place to look from and a point to look at. Keyed apart they drift apart: a
// place keyed without its target looks somewhere else as soon as the view is panned. So
// the two are always keyed, and unkeyed, together.
const VIEW_TARGETS = ['camera.position', 'camera.target']
const linked = (target: string) => (VIEW_TARGETS.includes(target) ? VIEW_TARGETS : [target])
/** How long the view must rest before a move of it counts as finished, in milliseconds */
const VIEW_SETTLE = 350

const stem = (filename: string) => filename.replace(/\.(compressed\.ply|ply|sog|json)$/i, '')
const round = (n: number, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits

const SECTION_COLOR = { keep: [0.35, 0.85, 1], cut: [1, 0.5, 0.3] }
const FORCE_COLOR = [0.85, 0.5, 1]
const CAMERA_COLOR = [1, 0.78, 0.1]
const PATH_STEPS = 96
const KEY_MARK = 0.05

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
  /** Axis views, projection and the name of what the viewport shows */
  readonly nav: ViewNavigation
  doc: Doc | null = null
  settings = defaultSettings()
  tool: Tool = 'navigate'
  showGrid = true
  /** The section box or force the gizmo tools act on; null = the splat itself */
  active: ActiveObject | null = null
  activeAnnotation: number | null = null
  /** Run the scene's forces in the viewport. They rest while a selection tool is in use. */
  flowPreview = true
  /** The playhead, in seconds */
  time = 0
  playing = false
  /** What the timeline counts in. Either way, times are kept in seconds. */
  timeUnits: 'seconds' | 'frames' = 'seconds'
  /** Write a key whenever an animatable property is changed */
  autoKey = false
  /** Look through the animated camera; off leaves the viewport free and draws the camera's path */
  followCamera = true
  /** A video is being rendered: the timeline is stepped by the renderer, not by the clock */
  rendering = false

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
  /** When the viewer last moved the viewport camera, while that move still waits to be keyed or mentioned; 0 otherwise */
  private viewMovedAt = 0
  /** Where the viewport camera was when the panels last heard about it */
  private viewSeen = ''

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
    // all the way to the poles, for the top and bottom views
    controls.limits.minPitch = -90
    controls.limits.maxPitch = 90
    this.nav = new ViewNavigation(viewer)
    this.nav.onChange = () => this.events.emit('view')
    this.nav.onUserMove = () => (this.viewMovedAt = performance.now())

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
      this.nav.update()
      if (this.viewMovedAt && !controls.dragging && performance.now() - this.viewMovedAt > VIEW_SETTLE) this.viewSettled()
      if (this.playing && !this.rendering) this.stepPlayback(dt)
      if (this.doc?.effects.advance(dt)) viewer.requestRender()
      this.callouts.update()
      this.frames.update()
    })
    app.on('prerender', () => {
      this.noteView()
      this.drawHelpers()
    })
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

      this.time = 0
      this.playing = false
      this.applyTool()
      this.syncScene()
      this.applyTime()
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
    if (scene.animation) s.animation = JSON.parse(JSON.stringify(scene.animation))
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
    // with auto-key on, the key this change writes is part of the same undo step
    const tracksBefore = JSON.stringify(this.animation.tracks)
    if (this.autoKey && !this.playing) {
      for (const prop of ANIMATABLE.splat) {
        if (JSON.stringify(before[prop]) !== JSON.stringify(after[prop])) insertKey(this.animation, targetOf('splat', prop), this.time, after[prop])
      }
    } else if (ANIMATABLE.splat.some((prop) => JSON.stringify(before[prop]) !== JSON.stringify(after[prop]) && this.isAnimated(targetOf('splat', prop)))) {
      this.warnUnkeyed()
    }
    const tracksAfter = JSON.stringify(this.animation.tracks)
    const setTracks = (json: string) => {
      this.animation.tracks = JSON.parse(json)
      this.events.emit('animation')
    }
    this.history.push({
      label: 'Transform',
      undo: () => {
        setTracks(tracksBefore)
        this.applyTransform(entity, before)
      },
      redo: () => {
        setTracks(tracksAfter)
        this.applyTransform(entity, after)
      },
    })
    if (tracksAfter !== tracksBefore) this.events.emit('animation')
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

  /** Bring the splat into view without turning the camera, so an axis view stays one. */
  frame() {
    this.viewer.frameScene(true, true)
  }

  /** Put the viewport camera somewhere by its numbers. */
  setViewPose(patch: Partial<Pick<CameraPose, 'position' | 'target'>>) {
    this.viewer.controls.setPose({ ...this.viewer.controls.getPose(), ...patch })
    this.nav.leaveCamera()
    this.viewMovedAt = performance.now()
    this.viewer.requestRender()
    this.events.emit('view')
  }

  /**
   * The viewer has finished moving the view. If the viewport is the animated camera, that
   * move was a move of the camera: with Auto-key on it is keyed, as Blender keys a camera
   * locked to the view; otherwise it will be gone at the next move of the playhead, which
   * is worth saying once.
   */
  private viewSettled() {
    this.viewMovedAt = 0
    if (!this.doc || this.playing || this.rendering || !this.followCamera || !this.hasCameraKeys) return
    if (!VIEW_TARGETS.some((target) => this.keyState(target).changed)) return
    if (this.autoKey) {
      this.keyTargets('Key camera', VIEW_TARGETS)
      this.events.emit('notice', `Auto-keyed the camera at ${this.formatTime()}`)
    } else {
      this.events.emit('notice', 'The camera is animated: this view lasts until the playhead moves. Shift+K keys it, and Auto-key keys every move.')
    }
  }

  /** A frame is about to be drawn: tell the panels if the camera is somewhere new. */
  private noteView() {
    if (this.rendering) return
    const { camera, controls } = this.viewer
    const p = camera.getPosition()
    const r = camera.getRotation()
    const seen = `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)},${r.x.toFixed(5)},${r.y.toFixed(5)},${r.z.toFixed(5)},${r.w.toFixed(5)},${controls.distance.toFixed(4)},${controls.orthographic}`
    if (seen === this.viewSeen) return
    this.viewSeen = seen
    this.events.emit('view')
  }

  // ── scene objects: undo and syncing ──────────────────────────────────────

  private snapshotScene() {
    const { sections, sectionRest, annotations, forces, animation } = this.settings
    return JSON.stringify({ sections, sectionRest, annotations, forces, animation })
  }

  private restoreScene(snapshot: string) {
    Object.assign(this.settings, JSON.parse(snapshot))
    this.syncScene()
    // the snapshot holds values from wherever the playhead was then; put them where it is now
    this.applyTime()
  }

  private isAnimated(target: string) {
    return this.animation.tracks.some((track) => track.target === target)
  }

  private warnUnkeyed() {
    this.events.emit('notice', 'That property is animated: the change lasts until the playhead moves. Press K or turn on Auto-key to keep it.')
  }

  /** Change section boxes, forces or callouts as one undo step. */
  private editScene(label: string, mutate: () => void) {
    const before = this.snapshotScene()
    mutate()
    this.commitScene(label, before)
  }

  private commitScene(label: string, before: string) {
    if (!this.playing) {
      const changed = this.changedTargets(before)
      if (this.autoKey) for (const { target, value } of changed) insertKey(this.animation, target, this.time, value)
      else if (changed.some(({ target }) => this.isAnimated(target))) this.warnUnkeyed()
    }
    const after = this.snapshotScene()
    this.syncScene()
    if (after === before) return
    // keys were added, moved or removed: what they animate may now sit somewhere else
    if (JSON.stringify(JSON.parse(before).animation) !== JSON.stringify(this.animation)) this.applyTime()
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
    this.placeNodes()

    const list = this.active ? (this.active.kind === 'section' ? sections : forces) : null
    if (this.active && this.active.index >= list!.length) this.active = null
    if (this.activeAnnotation !== null && this.activeAnnotation >= annotations.length) this.activeAnnotation = null

    this.applySections()
    this.applyForces()
    this.callouts.setSelected(this.activeAnnotation)
    this.attachGizmo()
    this.viewer.requestRender(3)
    this.events.emit('scene')
    this.events.emit('animation')
  }

  /** Put the helper nodes (what the gizmo holds and the wireframes follow) where the scene data says. */
  private placeNodes() {
    const { sections, forces } = this.settings
    sections.forEach((s, i) => {
      const node = this.sectionNodes[i]
      if (!node) return
      node.setLocalPosition(...s.position)
      node.setLocalEulerAngles(...s.rotation)
      node.setLocalScale(...s.size)
    })
    forces.forEach((f, i) => {
      const node = this.forceNodes[i]
      if (!node) return
      node.setLocalPosition(...f.position)
      node.setLocalEulerAngles(...(f.rotation ?? [0, 0, 0]))
      node.setLocalScale(f.radius, f.radius, f.radius)
    })
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

  // ── animation ────────────────────────────────────────────────────────────

  get animation() {
    return this.settings.animation
  }

  /** Frames per second of the timeline and of a rendered video */
  get fps() {
    return this.animation.fps ?? DEFAULT_FPS
  }

  setFps(fps: number) {
    if (!Number.isFinite(fps)) return
    // keys keep their times in seconds, so the motion does not change speed: only the count of frames does
    this.editScene('Change frame rate', () => {
      this.animation.fps = Math.min(Math.max(round(fps), 1), 240)
    })
  }

  /** Show the timeline in seconds or in frames. */
  setTimeUnits(units: 'seconds' | 'frames') {
    if (this.timeUnits === units) return
    this.timeUnits = units
    // counted in frames, the playhead sits on one
    if (units === 'frames' && !this.playing) this.time = this.onFrame(this.time)
    this.applyTime()
    this.events.emit('animation')
    this.events.emit('time')
  }

  /** The time of the frame nearest to `t` */
  private onFrame(t: number) {
    return Math.min(round(Math.round(t * this.fps) / this.fps, 4), this.animation.duration)
  }

  /** A time the way the timeline is showing it: "3.00 s" or "frame 72" */
  formatTime(t = this.time) {
    return this.timeUnits === 'frames' ? `frame ${Math.round(t * this.fps)}` : `${t.toFixed(2)} s`
  }

  /** Move the playhead and put everything animated where it is at that time. */
  setTime(t: number) {
    // a move of the camera still waiting to be auto-keyed belongs to the time it was made at
    if (this.viewMovedAt && this.autoKey) this.viewSettled()
    this.viewMovedAt = 0
    this.time = Math.min(Math.max(round(t, 4), 0), this.animation.duration)
    this.applyTime()
    this.events.emit('time')
  }

  play() {
    if (!this.doc || this.playing) return
    if (this.viewMovedAt && this.autoKey) this.viewSettled()
    // pressing play at the end starts over, as it does everywhere
    if (this.time >= this.animation.duration - 1e-3) this.time = 0
    this.playing = true
    this.events.emit('time')
  }

  pause() {
    if (!this.playing) return
    this.playing = false
    this.time = this.timeUnits === 'frames' ? this.onFrame(this.time) : round(this.time)
    this.afterPlayback()
  }

  togglePlay() {
    if (this.playing) this.pause()
    else this.play()
  }

  private stepPlayback(dt: number) {
    const { duration, loop } = this.animation
    let t = this.time + dt
    if (t >= duration) {
      if (loop !== false) t %= duration
      else {
        t = duration
        this.playing = false
      }
    }
    this.time = t
    this.applyTime()
    this.events.emit('time')
    if (!this.playing) this.afterPlayback()
  }

  /** Playback only moves things; the panels and helpers that follow them catch up when it stops. */
  private afterPlayback() {
    this.applyTime()
    this.applySections()
    this.attachGizmo()
    this.events.emit('time')
    this.events.emit('scene')
    this.events.emit('transform')
  }

  /** Sample every track at the playhead and write the values into the scene. */
  private applyTime() {
    const doc = this.doc
    if (!doc) return
    const entity = doc.splat.entity
    const camera: { position?: number[]; target?: number[]; fov?: number } = {}
    let sceneChanged = false
    let splatChanged = false

    evaluate(this.animation, this.time, (ref, value) => {
      if (ref.kind === 'splat') {
        if (typeof value === 'number') return
        if (ref.prop === 'position') entity.setLocalPosition(value[0], value[1], value[2])
        else if (ref.prop === 'rotation') entity.setLocalEulerAngles(value[0], value[1], value[2])
        else entity.setLocalScale(Math.max(value[0], MIN_SCALE), Math.max(value[1], MIN_SCALE), Math.max(value[2], MIN_SCALE))
        splatChanged = true
      } else if (ref.kind === 'camera') {
        if (ref.prop === 'fov') {
          if (typeof value === 'number') camera.fov = value
        } else if (typeof value !== 'number') camera[ref.prop as 'position' | 'target'] = value
      } else if (writeSceneValue(this.settings, ref, value)) {
        sceneChanged = true
      }
    })

    if (sceneChanged) {
      this.placeNodes()
      if (this.playing || this.rendering) {
        // the light path: uniforms and box frames only, sixty times a second
        doc.effects.setSections(this.settings.sections, restOpacity(this.settings.sectionRest))
        this.frames.refresh()
      } else {
        this.applySections()
      }
      this.applyForces()
    }

    // the viewport looks through the animated camera only when asked to; otherwise it stays free
    if (this.followCamera && (camera.position || camera.target || camera.fov !== undefined)) {
      const pose = this.viewer.controls.getPose()
      this.viewer.controls.setPose({
        position: (camera.position as Vec3Tuple | undefined) ?? pose.position,
        target: (camera.target as Vec3Tuple | undefined) ?? pose.target,
      })
      if (camera.fov !== undefined) {
        this.settings.fov = camera.fov
        this.viewer.setFov(camera.fov)
      }
      // the scene's camera is a perspective camera, whatever the viewport was showing
      if (camera.position || camera.target) this.nav.enterCamera()
    }

    if (!this.playing && !this.rendering) {
      if (splatChanged) {
        this.attachGizmo()
        this.events.emit('transform')
      }
      if (sceneChanged) this.events.emit('scene')
    }
    this.viewer.requestRender(2)
  }

  /** What a target is right now, for writing a key from it. */
  private valueOf(ref: TargetRef): AnimValue | null {
    if (ref.kind === 'splat') {
      const t = this.getTransform()
      return t ? [...t[ref.prop as keyof Transform]] : null
    }
    if (ref.kind === 'camera') {
      if (ref.prop === 'fov') return this.viewer.fov
      return [...this.viewer.controls.getPose()[ref.prop as 'position' | 'target']]
    }
    return readSceneValue(this.settings, ref)
  }

  private keyTargets(label: string, targets: string[]) {
    if (!this.doc) return
    this.editScene(label, () => {
      for (const target of targets) {
        const ref = parseTarget(target)
        const value = ref ? this.valueOf(ref) : null
        if (value !== null) insertKey(this.animation, target, this.time, value)
      }
    })
  }

  /** Key everything about what is being edited: the active force or box, otherwise the splat. */
  keySelected() {
    const { active } = this
    const kind = active?.kind ?? 'splat'
    const name = active ? (active.kind === 'force' ? this.settings.forces : this.settings.sections)[active.index]?.name || kind : 'the splat'
    this.keyTargets('Add keys', ANIMATABLE[kind].map((prop) => targetOf(kind, prop, active?.index)))
    this.events.emit('notice', `Keyed ${name} at ${this.formatTime()}`)
  }

  /** Key the view: where the viewport camera is now becomes where the animated camera is at this time. */
  keyCamera() {
    this.keyTargets('Key camera', ANIMATABLE.camera.map((prop) => targetOf('camera', prop)))
    this.events.emit('notice', `Keyed the camera at ${this.formatTime()}`)
  }

  /** Add a key to one track at the playhead, with the value it has there. */
  keyTrack(target: string) {
    this.keyTargets('Add key', linked(target))
  }

  /**
   * How a property stands on the timeline at the playhead. The camera's position and target
   * are one view, so they answer as one: both diamonds always show the same.
   */
  keyState(target: string): KeyState {
    const states = linked(target).map((one) => this.trackState(one))
    const animated = states.filter((state) => state.animated)
    return {
      animated: animated.length > 0,
      onKey: animated.length > 0 && animated.every((state) => state.onKey),
      changed: animated.some((state) => state.changed),
    }
  }

  private trackState(target: string): KeyState {
    const track = this.animation.tracks.find((candidate) => candidate.target === target)
    const ref = parseTarget(target)
    if (!this.doc || !track || !ref || track.keys.length === 0) return { animated: false, onKey: false, changed: false }
    const now = this.valueOf(ref)
    const then = sampleTarget(this.animation, target, this.time)
    return {
      animated: true,
      onKey: track.keys.some((key) => Math.abs(key.t - this.time) < SAME_TIME),
      changed: now !== null && then !== null && !sameValue(ref.prop, now, constrain(ref, then)),
    }
  }

  /**
   * What clicking the diamond beside a property does, as in Blender: key it at the playhead,
   * or, where a key already sits and the value has not been touched since, take that key away.
   */
  toggleKey(target: string) {
    if (!this.doc) return
    const state = this.keyState(target)
    const at = this.formatTime()
    const targets = linked(target)
    const what = targets.length > 1 ? 'the camera’s view' : this.trackLabel(target)
    if (state.onKey && !state.changed) {
      const keys = targets.flatMap((one) => {
        const key = this.animation.tracks.find((candidate) => candidate.target === one)?.keys.find((candidate) => Math.abs(candidate.t - this.time) < SAME_TIME)
        return key ? [{ target: one, key }] : []
      })
      this.removeKeys(keys)
      this.events.emit('notice', `Removed the key on ${what} at ${at}`)
    } else {
      this.keyTargets('Add key', targets)
      this.events.emit('notice', `Keyed ${what} at ${at}`)
    }
  }

  /** A key is about to be dragged along its track: the whole drag is one undo step. */
  beginKeyEdit() {
    this.beginSceneEdit()
  }

  /** Put keys at new times, all at once: a drag of one key or of a whole selection. */
  moveKeys(moves: { target: string; key: Keyframe; t: number }[]) {
    const touched = new Set<string>()
    for (const { target, key, t } of moves) {
      key.t = Math.min(Math.max(round(t, 4), 0), this.animation.duration)
      touched.add(target)
    }
    for (const track of this.animation.tracks) if (touched.has(track.target)) track.keys.sort((a, b) => a.t - b.t)
    this.applyTime()
  }

  endKeyEdit(label = 'Move key') {
    this.endSceneEdit(label)
  }

  removeKey(target: string, key: Keyframe) {
    this.removeKeys([{ target, key }])
  }

  /** Delete keys as one undo step. A track left with no keys goes with them. */
  removeKeys(keys: { target: string; key: Keyframe }[]) {
    if (keys.length === 0) return
    const gone = new Set(keys.map(({ key }) => key))
    this.editScene(keys.length === 1 ? 'Delete key' : `Delete ${keys.length} keys`, () => {
      for (const track of this.animation.tracks) track.keys = track.keys.filter((key) => !gone.has(key))
      this.animation.tracks = this.animation.tracks.filter((track) => track.keys.length > 0)
    })
  }

  setKeysEase(keys: Keyframe[], ease: NonNullable<Keyframe['ease']>) {
    this.editScene('Change key easing', () => {
      for (const key of keys) {
        if (ease === 'smooth') delete key.ease
        else key.ease = ease
      }
    })
  }

  removeTrack(target: string) {
    this.editScene('Remove animation track', () => {
      this.animation.tracks = this.animation.tracks.filter((track) => track.target !== target)
    })
  }

  setDuration(seconds: number) {
    this.editScene('Change animation length', () => {
      // four places, so a length given in frames survives the trip through seconds
      this.animation.duration = Math.max(round(seconds, 4), 0.1)
    })
    if (this.time > this.animation.duration) this.setTime(this.animation.duration)
  }

  setLoop(loop: boolean) {
    this.editScene('Change looping', () => {
      this.animation.loop = loop
    })
  }

  /** While on, changing an animatable property writes a key at the playhead, as Blender's record button does. */
  setAutoKey(on: boolean) {
    this.autoKey = on
    this.events.emit('animation')
  }

  setFollowCamera(on: boolean) {
    this.followCamera = on
    if (!on) this.nav.leaveCamera()
    this.applyTime()
    this.events.emit('animation')
  }

  /** Whether there is an animated camera to look through */
  get hasCameraKeys() {
    return this.animation.tracks.some((track) => track.target === 'camera.position' || track.target === 'camera.target')
  }

  /** A readable name for a track: "Updraft swirl · Strength". */
  trackLabel(target: string): string {
    const ref = parseTarget(target)
    if (!ref) return target
    const prop = PROP_LABELS[ref.prop] ?? ref.prop
    if (ref.kind === 'splat') return `Splat · ${prop}`
    if (ref.kind === 'camera') return `Camera · ${prop}`
    if (ref.kind === 'rest') return 'Rest of the splat · Opacity'
    const item = (ref.kind === 'force' ? this.settings.forces : this.settings.sections)[ref.index]
    return `${item?.name || (ref.kind === 'force' ? 'Force' : 'Box')} · ${prop}`
  }

  /** The animatable properties that differ between an earlier snapshot of the scene and now. */
  private changedTargets(before: string): { target: string; value: AnimValue }[] {
    const was = JSON.parse(before) as Pick<SceneSettings, 'sections' | 'sectionRest' | 'forces'>
    const now = this.settings
    const changed: { target: string; value: AnimValue }[] = []
    const compare = (kind: 'force' | 'section', a: object[], b: object[]) => {
      // adding or removing one is not a change to any of them
      if (a.length !== b.length) return
      b.forEach((item, i) => {
        for (const prop of ANIMATABLE[kind]) {
          const value = (item as Record<string, AnimValue | undefined>)[prop]
          if (value !== undefined && JSON.stringify((a[i] as Record<string, unknown>)[prop]) !== JSON.stringify(value)) {
            changed.push({ target: targetOf(kind, prop, i), value })
          }
        }
      })
    }
    compare('force', was.forces, now.forces)
    compare('section', was.sections, now.sections)
    if (was.sectionRest.opacity !== now.sectionRest.opacity) changed.push({ target: 'rest.opacity', value: now.sectionRest.opacity })
    return changed
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
      dropTracksFor(this.animation, 'section', index)
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
      dropTracksFor(this.animation, 'force', index)
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
    if (s.animation.tracks.length) scene.animation = JSON.parse(JSON.stringify(s.animation))
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

  /**
   * Run `task` with the viewport showing only what the player would: no grid, boxes, gizmo,
   * camera path or selection tint.
   */
  private async withCleanView<T>(task: () => Promise<T>): Promise<T> {
    const doc = this.doc
    if (!doc) throw new Error('Nothing to capture')
    const { flags } = doc.state
    const selected: number[] = []
    for (let i = 0; i < flags.length; i++) if (flags[i] & SELECTED) selected.push(i)
    for (const i of selected) flags[i] = 0
    if (selected.length) doc.state.commit()
    this.helpersHidden = true
    for (const gizmo of Object.values(this.gizmos)) gizmo.detach()
    // the player and a video look through the scene's camera, which is never orthographic
    const restoreProjection = this.nav.borrowPerspective()
    try {
      // the tint is removed in the work buffer, which lags the flags by a frame
      this.viewer.app.render()
      return await task()
    } finally {
      for (const i of selected) flags[i] = SELECTED
      if (selected.length) doc.state.commit()
      this.helpersHidden = false
      restoreProjection()
      this.attachGizmo()
      this.viewer.requestRender(2)
    }
  }

  /** A still of the current view with the editor's helpers hidden: the player's poster image. */
  capturePoster() {
    return this.withCleanView(() => this.viewer.capture('image/webp', 0.9))
  }

  /**
   * Render the timeline, start to end, to an .mp4 (H.264). Frames are stepped one at a time
   * at exactly `fps`, not captured from the screen, so the result is the same on a slow
   * machine as on a fast one. The view is the animated camera's; without camera keys it is
   * wherever the viewport camera is.
   */
  async renderVideo(options: { width: number; height: number; fps: number; quality: 'high' | 'max'; labels?: boolean; onProgress?: (fraction: number) => void; signal?: AbortSignal }): Promise<Blob> {
    if (!this.doc) throw new Error('Nothing to render')
    if (this.rendering) throw new Error('A render is already running')
    // loaded on demand: the encoder is only needed by whoever renders a video
    const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, QUALITY_VERY_HIGH, canEncodeVideo } = await import('mediabunny')
    // H.264 wants even dimensions
    const width = Math.max(2, Math.round(options.width / 2) * 2)
    const height = Math.max(2, Math.round(options.height / 2) * 2)
    const quality = options.quality === 'max' ? QUALITY_VERY_HIGH : QUALITY_HIGH
    if (!(await canEncodeVideo('avc', { width, height, quality }))) {
      throw new Error(`This browser cannot encode H.264 video at ${width}×${height}. Use a current Chrome or Edge, or a smaller size.`)
    }

    const { fps } = options
    const frames = Math.max(1, Math.round(this.animation.duration * fps))
    this.pause()
    const resumeAt = this.time
    const follow = this.followCamera
    // the render rides the animated camera; a free viewport gets its own view back afterwards
    const { controls } = this.viewer
    const view = { yaw: controls.yaw, pitch: controls.pitch, distance: controls.distance, target: controls.target.clone() }
    this.rendering = true
    this.followCamera = true

    try {
      return await this.withCleanView(async () => {
        // Labels are HTML over the canvas, so a frame with labels is put together on a second
        // canvas: the rendered picture, then the labels drawn over it. They are sized against
        // the viewport, so they fill the same share of the video as they do on screen.
        const compose = options.labels && this.hasLabels ? this.labelComposer(width, height) : null
        this.viewer.beginOffline(width, height)
        const target = new BufferTarget()
        const output = new Output({ format: new Mp4OutputFormat(), target })
        const source = new CanvasSource(compose?.canvas ?? this.viewer.canvas, { codec: 'avc', quality })
        output.addVideoTrack(source, { frameRate: fps })
        await output.start()
        try {
          const clock = performance.now()
          for (let i = 0; i < frames; i++) {
            if (options.signal?.aborted) throw new DOMException('Render cancelled', 'AbortError')
            this.time = i / fps
            this.applyTime()
            await this.viewer.stepFrame(clock + (i * 1000) / fps)
            // the canvas is read here, in the same task that drew it
            compose?.draw()
            await source.add(i / fps, 1 / fps)
            options.onProgress?.((i + 1) / frames)
            // let the page paint the progress now and then
            if (i % 6 === 5) await nextTask()
          }
          await output.finalize()
          if (!target.buffer) throw new Error('The encoder produced no data')
          return new Blob([target.buffer], { type: 'video/mp4' })
        } catch (error) {
          await output.cancel().catch(() => {})
          throw error
        } finally {
          this.viewer.endOffline()
        }
      })
    } finally {
      this.rendering = false
      this.followCamera = follow
      if (!follow) {
        controls.yaw = view.yaw
        controls.pitch = view.pitch
        controls.distance = view.distance
        controls.target.copy(view.target)
        controls.snap()
        this.nav.leaveCamera()
      }
      this.setTime(resumeAt)
      this.afterPlayback()
    }
  }

  /** Whether the scene has any label a video could show: a pinned one, or a labelled box */
  get hasLabels() {
    const { annotations, sections } = this.settings
    return annotations.some((a) => a.title || a.text) || sections.some((box) => box.label === true && box.enabled !== false)
  }

  /** A canvas the size of a video frame, and a function that fills it with the rendered picture and the labels over it. */
  private labelComposer(width: number, height: number) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('This browser could not make a canvas to draw the labels on')
    // the labels as the page styles them: its typeface and color, haloed in the stage color
    const computed = getComputedStyle(this.callouts.root)
    const style = { color: computed.color || '#fff', font: computed.fontFamily || 'sans-serif', halo: this.settings.background ?? '#000' }
    const scale = height / Math.max(this.viewer.canvas.clientHeight, 1)
    return {
      canvas,
      draw: () => {
        const { annotations, sections, sectionRest } = this.settings
        ctx.fillStyle = style.halo
        ctx.fillRect(0, 0, width, height)
        ctx.drawImage(this.viewer.canvas, 0, 0, width, height)
        // a label whose point is cut away (not merely faded) goes with it, as in the player
        const culled = restOpacity(sectionRest) > 0 ? null : sectionTest(sections)
        paintLabels(ctx, width, height, scale, { camera: this.viewer.camera, annotations, culled, sections }, style)
      },
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
    // the animated camera's path, when the viewport is not riding along it
    const path = this.followCamera ? undefined : this.animation.tracks.find((track) => track.target === 'camera.position')
    if (path && path.keys.length > 1) {
      const from = path.keys[0].t
      const to = path.keys[path.keys.length - 1].t
      // the path as playback will fly it: an arc around the target, not a chord
      const at = (t: number) => {
        const v = sampleTarget(this.animation, 'camera.position', t) as number[]
        return new Vec3(v[0], v[1], v[2])
      }
      let previous = at(from)
      for (let s = 1; s <= PATH_STEPS; s++) {
        const next = at(from + ((to - from) * s) / PATH_STEPS)
        segment(previous, next, CAMERA_COLOR, 0.9)
        previous = next
      }
      // a small cross at every key
      for (const key of path.keys) {
        const p = key.v as number[]
        for (const axis of [Vec3.RIGHT, Vec3.UP, Vec3.BACK]) {
          segment(new Vec3(p[0], p[1], p[2]).sub(b.copy(axis).mulScalar(KEY_MARK)), new Vec3(p[0], p[1], p[2]).add(b.copy(axis).mulScalar(KEY_MARK)), CAMERA_COLOR, 1)
        }
      }
    }
    if (positions.length === 0) return
    // drawn over the splat: a box buried inside it would otherwise be impossible to find
    app.drawLineArrays(positions, colors, false)
  }
}
