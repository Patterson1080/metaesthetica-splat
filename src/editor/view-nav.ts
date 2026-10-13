import type { Move } from '../core/orbit-controls'
import type { SplatViewer } from '../core/viewer'

export type AxisView = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom'

/**
 * The six views along the world's axes. Y is up here, so the camera of the front view
 * stands on +Z and that of the top view on +Y. Top and bottom keep X to the right.
 */
export const AXIS_VIEWS: Record<AxisView, { yaw: number; pitch: number; opposite: AxisView; label: string; axis: string }> = {
  front: { yaw: 0, pitch: 0, opposite: 'back', label: 'Front', axis: '+Z' },
  back: { yaw: 180, pitch: 0, opposite: 'front', label: 'Back', axis: '−Z' },
  right: { yaw: 90, pitch: 0, opposite: 'left', label: 'Right', axis: '+X' },
  left: { yaw: -90, pitch: 0, opposite: 'right', label: 'Left', axis: '−X' },
  top: { yaw: 0, pitch: -90, opposite: 'bottom', label: 'Top', axis: '+Y' },
  bottom: { yaw: 0, pitch: 90, opposite: 'top', label: 'Bottom', axis: '−Y' },
}

const ALIGNED = 0.01 // degrees
/** Signed difference between two headings, in -180..180 */
const turn = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180

/**
 * Viewport navigation the way Blender does it: views that snap to the axes, an orthographic
 * projection that comes with them and leaves again when the view is orbited away ("auto
 * perspective"), and a name for whatever the viewport is showing.
 *
 * This is about the editor's own viewport only. The scene's camera, the one the player and
 * a rendered video look through, is always a perspective camera.
 */
export class ViewNavigation {
  /** The projection or the view's name changed */
  onChange: (() => void) | null = null
  /** The viewer moved the viewport camera: by mouse, by the gizmo, or by a shortcut */
  onUserMove: (() => void) | null = null
  /** The viewport is showing what the animated camera sees at the playhead */
  throughCamera = false

  private readonly viewer: SplatViewer
  /** Orthographic came with an axis view, so it goes when the view is orbited away */
  private autoOrtho = false
  /** Switch to orthographic once the turn toward an axis view has finished */
  private pendingOrtho = false

  constructor(viewer: SplatViewer) {
    this.viewer = viewer
    viewer.controls.onMove = (move) => this.moved(move)
  }

  get orthographic() {
    return this.viewer.controls.orthographic
  }

  /** The axis view the viewport is in, or on its way to */
  get axis(): AxisView | null {
    const { yaw, pitch } = this.viewer.controls
    for (const [name, view] of Object.entries(AXIS_VIEWS) as [AxisView, (typeof AXIS_VIEWS)[AxisView]][]) {
      if (Math.abs(pitch - view.pitch) < ALIGNED && Math.abs(turn(yaw, view.yaw)) < ALIGNED) return name
    }
    return null
  }

  /** What Blender writes in the corner of its viewport: "Front Orthographic", "User Perspective" */
  get name() {
    if (this.throughCamera) return 'Camera Perspective'
    const axis = this.axis
    const ortho = this.orthographic || this.pendingOrtho
    return `${axis ? AXIS_VIEWS[axis].label : 'User'} ${ortho ? 'Orthographic' : 'Perspective'}`
  }

  /**
   * Turn to an axis view. From a perspective view this also switches to orthographic, as
   * Blender's auto perspective does. With `flip`, asking for the view already shown gives
   * the opposite one, which is what clicking an axis of the gizmo twice does.
   */
  snap(view: AxisView, flip = false) {
    const to = flip && this.axis === view ? AXIS_VIEWS[view].opposite : view
    const { yaw, pitch } = AXIS_VIEWS[to]
    this.throughCamera = false
    this.viewer.controls.lookFrom(yaw, pitch)
    this.onUserMove?.()
    if (!this.orthographic) {
      this.autoOrtho = true
      this.pendingOrtho = true
    }
    this.viewer.requestRender()
    this.onChange?.()
  }

  /** Look from the other side */
  opposite() {
    const axis = this.axis
    if (axis) return this.snap(AXIS_VIEWS[axis].opposite)
    const { controls } = this.viewer
    this.throughCamera = false
    controls.lookFrom(controls.yaw + 180, -controls.pitch)
    this.onUserMove?.()
    this.viewer.requestRender()
    this.onChange?.()
  }

  orbit(yaw: number, pitch: number) {
    this.viewer.controls.orbitBy(yaw, pitch)
    this.viewer.requestRender()
  }

  zoom(factor: number) {
    this.viewer.controls.zoomBy(factor)
    this.viewer.requestRender()
  }

  pan(dx: number, dy: number) {
    this.viewer.controls.panBy(dx, dy)
    this.viewer.requestRender()
  }

  /** Switch projection by hand. A choice made this way stays until it is made again. */
  toggleOrthographic() {
    this.setOrthographic(!(this.orthographic || this.pendingOrtho))
  }

  setOrthographic(on: boolean) {
    this.autoOrtho = false
    this.pendingOrtho = false
    if (on) this.throughCamera = false
    this.project(on)
  }

  /** The animated camera took the viewport: it is a perspective camera, wherever it points. */
  enterCamera() {
    this.pendingOrtho = false
    this.autoOrtho = false
    const changed = !this.throughCamera || this.orthographic
    this.throughCamera = true
    this.viewer.controls.orthographic = false
    if (changed) this.onChange?.()
  }

  leaveCamera() {
    if (!this.throughCamera) return
    this.throughCamera = false
    this.onChange?.()
  }

  /**
   * Show the scene through a perspective camera for as long as a picture of it is being
   * taken (poster, video); the returned function puts the viewport back.
   */
  borrowPerspective(): () => void {
    const { controls } = this.viewer
    const was = controls.orthographic
    const auto = this.autoOrtho
    controls.orthographic = false
    return () => {
      controls.orthographic = was
      this.autoOrtho = auto
      this.viewer.requestRender(2)
    }
  }

  /** Once a frame: the switch to orthographic waits for the turn to finish, so the turn is seen in perspective. */
  update() {
    // the last fraction of a degree eases in for a long second; nobody sees the switch before it
    if (this.pendingOrtho && this.viewer.controls.turning < 0.3) {
      this.pendingOrtho = false
      // only if the turn ended where it was sent
      if (this.axis) this.project(true)
      else this.autoOrtho = false
    }
  }

  private project(orthographic: boolean) {
    this.viewer.controls.orthographic = orthographic
    this.viewer.requestRender(2)
    this.onChange?.()
  }

  private moved(move: Move) {
    this.onUserMove?.()
    const wasCamera = this.throughCamera
    this.throughCamera = false
    if (move === 'orbit') {
      // orbiting out of an axis view takes its orthographic projection with it
      const leaving = this.autoOrtho && (this.orthographic || this.pendingOrtho)
      this.pendingOrtho = false
      this.autoOrtho = false
      if (leaving) return this.project(false)
    }
    if (wasCamera) this.onChange?.()
  }
}
