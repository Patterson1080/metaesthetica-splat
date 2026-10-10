import { Vec3, math, type Entity } from 'playcanvas'
import type { CameraPose, ControlLimits } from './scene'

export type DragAction = 'orbit' | 'pan' | null

/** Decides what a pointer press does. Return null to leave the press to something else (a tool, a gizmo). */
export type DragFilter = (e: PointerEvent) => DragAction

const defaultFilter: DragFilter = (e) => {
  if (e.pointerType === 'touch') return 'orbit'
  if (e.button === 0) return e.shiftKey ? 'pan' : 'orbit'
  if (e.button === 1 || e.button === 2) return 'pan'
  return null
}

const ORBIT_SPEED = 0.3 // degrees per CSS pixel
const KEY_ORBIT_STEP = 8 // degrees per arrow key press
const WHEEL_SPEED = 0.0012
const DAMPING = 0.09 // seconds for motion to settle to ~1/e
const EPSILON = 1e-5

/**
 * Orbit / pan / zoom camera for an embedded canvas. Unlike a full-page viewer it has to be a
 * good guest on a scrolling page, so wheel zoom can be switched off (`wheelEnabled`) and then
 * leaves the wheel event to the page; the owner decides when the viewer has "entered" it.
 *
 * The camera sits at `target + rotate(yaw, pitch) * (0, 0, distance)`; negative pitch looks
 * down on the target.
 */
export class OrbitControls {
  readonly target = new Vec3()
  yaw = 0
  pitch = -15
  distance = 5

  limits: Required<Omit<ControlLimits, 'autoRotate'>> = {
    minDistance: 0.05,
    maxDistance: 1000,
    minPitch: -89.5,
    maxPitch: 89.5,
    pan: true,
  }
  /** Degrees per second while the viewer is not interacting */
  autoRotate = 0
  enabled = true
  /** Wheel and pinch zoom only act (and only block page scroll) while this is true */
  wheelEnabled = true
  dragFilter: DragFilter = defaultFilter
  /** Called whenever the viewer touches the controls */
  onInteract: (() => void) | null = null

  private readonly camera: Entity
  private readonly element: HTMLElement
  private readonly current = { target: new Vec3(), yaw: 0, pitch: -15, distance: 5 }
  private readonly pointers = new Map<number, { x: number; y: number }>()
  private action: DragAction = null
  private pinch = { distance: 0, x: 0, y: 0 }
  private idle = 0
  private dirty = true
  private readonly abort = new AbortController()

  constructor(camera: Entity, element: HTMLElement) {
    this.camera = camera
    this.element = element
    const opts = { signal: this.abort.signal }
    element.addEventListener('pointerdown', this.onPointerDown, opts)
    element.addEventListener('pointermove', this.onPointerMove, opts)
    element.addEventListener('pointerup', this.onPointerUp, opts)
    element.addEventListener('pointercancel', this.onPointerUp, opts)
    element.addEventListener('wheel', this.onWheel, { ...opts, passive: false })
    element.addEventListener('keydown', this.onKeyDown, opts)
    // the right button pans, so its menu must not open over the canvas
    element.addEventListener('contextmenu', (e) => e.preventDefault(), opts)
  }

  destroy() {
    this.abort.abort()
    this.pointers.clear()
  }

  get dragging() {
    return this.action !== null
  }

  /** Drop the drag in progress, e.g. when a gizmo handle claims the same press. */
  cancel() {
    this.pointers.clear()
    this.action = null
  }

  // ── poses ────────────────────────────────────────────────────────────────

  getPose(): CameraPose {
    const p = this.positionFor(this.target, this.yaw, this.pitch, this.distance)
    const round = (n: number) => Math.round(n * 1e4) / 1e4
    return {
      position: [round(p.x), round(p.y), round(p.z)],
      target: [round(this.target.x), round(this.target.y), round(this.target.z)],
    }
  }

  /** Aim the camera from `position` at `target`; `animate` eases there instead of cutting. */
  setPose(pose: CameraPose, animate = false) {
    const dir = new Vec3(
      pose.position[0] - pose.target[0],
      pose.position[1] - pose.target[1],
      pose.position[2] - pose.target[2],
    )
    const distance = Math.max(dir.length(), EPSILON)
    this.target.set(pose.target[0], pose.target[1], pose.target[2])
    this.distance = distance
    this.pitch = -Math.asin(math.clamp(dir.y / distance, -1, 1)) * math.RAD_TO_DEG
    let yaw = Math.atan2(dir.x, dir.z) * math.RAD_TO_DEG
    // turn the short way round rather than unwinding a full revolution
    if (animate) yaw = this.current.yaw + (((yaw - this.current.yaw) % 360) + 540) % 360 - 180
    this.yaw = yaw
    if (!animate) this.snap()
    this.dirty = true
  }

  /** Frame a sphere so it fills the view at the given vertical field of view. */
  frame(center: Vec3, radius: number, fov: number, aspect = 1) {
    // fit the narrower of the two view angles so the sphere stays inside portrait canvases too
    const vertical = (fov * math.DEG_TO_RAD) / 2
    const half = Math.min(vertical, Math.atan(Math.tan(vertical) * aspect))
    this.target.copy(center)
    this.distance = Math.max(radius / Math.sin(Math.max(half, 0.05)), EPSILON) * 1.05
    this.dirty = true
  }

  /** Jump to the goal immediately, skipping the easing. */
  snap() {
    this.current.target.copy(this.target)
    this.current.yaw = this.yaw
    this.current.pitch = this.pitch
    this.current.distance = this.distance
    this.dirty = true
    this.apply()
  }

  // ── per-frame ────────────────────────────────────────────────────────────

  /** Advance the easing. Returns true when the camera moved and the frame needs redrawing. */
  update(dt: number): boolean {
    this.idle += dt
    if (this.autoRotate !== 0 && this.enabled && !this.dragging && this.idle > 2.5) {
      this.yaw += this.autoRotate * dt
      this.dirty = true
    }
    if (!this.dirty) return false

    this.clamp()
    const c = this.current
    const k = 1 - Math.exp(-dt / DAMPING)
    c.target.lerp(c.target, this.target, k)
    c.yaw += (this.yaw - c.yaw) * k
    c.pitch += (this.pitch - c.pitch) * k
    c.distance += (this.distance - c.distance) * k

    const settled =
      c.target.distance(this.target) < EPSILON * Math.max(1, this.distance) &&
      Math.abs(this.yaw - c.yaw) < 1e-3 &&
      Math.abs(this.pitch - c.pitch) < 1e-3 &&
      Math.abs(this.distance - c.distance) < EPSILON * Math.max(1, this.distance)
    if (settled) {
      this.snap()
      this.dirty = false
      return true
    }
    this.apply()
    return true
  }

  private clamp() {
    const l = this.limits
    this.pitch = math.clamp(this.pitch, l.minPitch, l.maxPitch)
    this.distance = math.clamp(this.distance, l.minDistance, l.maxDistance)
  }

  private positionFor(target: Vec3, yaw: number, pitch: number, distance: number) {
    const y = yaw * math.DEG_TO_RAD
    const p = pitch * math.DEG_TO_RAD
    const cp = Math.cos(p)
    return new Vec3(
      target.x + distance * Math.sin(y) * cp,
      target.y - distance * Math.sin(p),
      target.z + distance * Math.cos(y) * cp,
    )
  }

  private apply() {
    const c = this.current
    this.camera.setLocalEulerAngles(c.pitch, c.yaw, 0)
    this.camera.setLocalPosition(this.positionFor(c.target, c.yaw, c.pitch, c.distance))
  }

  // ── input ────────────────────────────────────────────────────────────────

  private touched() {
    this.idle = 0
    this.dirty = true
    this.onInteract?.()
  }

  private onPointerDown = (e: PointerEvent) => {
    if (!this.enabled) return
    const action = this.pointers.size === 0 ? this.dragFilter(e) : this.action
    if (!action) return
    if (this.pointers.size === 0) this.action = action
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    try {
      this.element.setPointerCapture(e.pointerId)
    } catch {
      // the pointer was released before the handler ran; the drag just ends at the element's edge
    }
    if (this.pointers.size === 2) this.pinch = this.measurePinch()
    this.touched()
  }

  private onPointerMove = (e: PointerEvent) => {
    const last = this.pointers.get(e.pointerId)
    if (!last || !this.enabled) return
    const dx = e.clientX - last.x
    const dy = e.clientY - last.y
    last.x = e.clientX
    last.y = e.clientY

    if (this.pointers.size >= 2) {
      // two fingers: spread to zoom, drag together to pan
      const pinch = this.measurePinch()
      if (this.pinch.distance > 0 && pinch.distance > 0) this.distance *= this.pinch.distance / pinch.distance
      this.pan(pinch.x - this.pinch.x, pinch.y - this.pinch.y)
      this.pinch = pinch
    } else if (this.action === 'pan') {
      this.pan(dx, dy)
    } else if (this.action === 'orbit') {
      this.yaw -= dx * ORBIT_SPEED
      this.pitch -= dy * ORBIT_SPEED
    }
    this.touched()
  }

  private onPointerUp = (e: PointerEvent) => {
    if (!this.pointers.delete(e.pointerId)) return
    if (this.element.hasPointerCapture(e.pointerId)) this.element.releasePointerCapture(e.pointerId)
    if (this.pointers.size === 0) this.action = null
    // a finger lifted from a pinch: the remaining one must not jump
    else this.pinch = this.measurePinch()
  }

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled || !this.wheelEnabled) return
    e.preventDefault()
    // deltaMode 1 = lines (Firefox mouse wheels); normalise to roughly pixels
    const delta = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY
    this.distance *= Math.exp(math.clamp(delta, -400, 400) * WHEEL_SPEED)
    this.touched()
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.enabled || e.ctrlKey || e.metaKey || e.altKey) return
    switch (e.key) {
      case 'ArrowLeft': this.yaw += KEY_ORBIT_STEP; break
      case 'ArrowRight': this.yaw -= KEY_ORBIT_STEP; break
      case 'ArrowUp': this.pitch -= KEY_ORBIT_STEP; break
      case 'ArrowDown': this.pitch += KEY_ORBIT_STEP; break
      case '+': case '=': this.distance *= 0.85; break
      case '-': case '_': this.distance *= 1.18; break
      default: return
    }
    e.preventDefault()
    this.touched()
  }

  private measurePinch() {
    const [a, b] = [...this.pointers.values()]
    if (!a || !b) return { distance: 0, x: a?.x ?? 0, y: a?.y ?? 0 }
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }

  /** Slide the target in the view plane so the scene follows the cursor. */
  private pan(dx: number, dy: number) {
    if (!this.limits.pan) return
    const fov = (this.camera.camera?.fov ?? 60) * math.DEG_TO_RAD
    const height = this.element.clientHeight || 1
    // world units per CSS pixel at the target's depth
    const scale = (2 * this.distance * Math.tan(fov / 2)) / height
    const right = this.camera.right
    const up = this.camera.up
    this.target.x += (-dx * right.x + dy * up.x) * scale
    this.target.y += (-dx * right.y + dy * up.y) * scale
    this.target.z += (-dx * right.z + dy * up.z) * scale
  }
}
