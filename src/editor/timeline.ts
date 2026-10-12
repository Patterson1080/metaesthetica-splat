import type { Keyframe } from '../core/scene'
import { button, h, icons, number, setValue, trim } from './dom'
import type { Editor } from './editor'

/** Keys snap to this grid while dragged, in seconds. Hold Shift to place freely. */
const SNAP = 0.05
const DRAG_SLOP = 3

const niceStep = (duration: number) => {
  // about ten labelled ticks, on a round number of seconds
  const raw = duration / 10
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60]
  return steps.find((step) => step >= raw) ?? 60
}

/**
 * The timeline dock: transport, a ruler with the playhead, and one row per animated
 * property with its keyframes. It owns no animation state; it draws what the editor holds
 * and calls the editor to change it.
 */
export function buildTimeline(root: HTMLElement, editor: Editor) {
  let selected: { target: string; key: Keyframe } | null = null

  // ── transport and keying ─────────────────────────────────────────────────

  const play = button('Play', () => editor.togglePlay(), { icon: icons.play, title: 'Play / pause (Space)' })
  const toStart = button('To start', () => editor.setTime(0), { icon: icons.toStart, title: 'Back to the start (Home)' })
  const time = number((value) => editor.setTime(value), { step: SNAP, min: 0, title: 'Playhead, in seconds' })
  const duration = number((value) => editor.setDuration(value), { step: 1, min: 0.5, title: 'Length of the animation, in seconds' })
  const loop = h('input', { type: 'checkbox' })
  loop.addEventListener('change', () => editor.setLoop(loop.checked))

  const autoKey = button('Auto-key', () => editor.setAutoKey(!editor.autoKey), {
    class: 'record',
    title: 'While on, changing an animatable property writes a key at the playhead',
  })
  autoKey.prepend(h('span', { class: 'icon', innerHTML: icons.record }))
  const keyObject = button('Key', () => editor.keySelected(), {
    title: 'Key what you are editing at the playhead: the active force or section box, otherwise the splat (K)',
  })
  const keyCamera = button('Key camera', () => editor.keyCamera(), {
    title: 'Key the current view as the camera’s position at the playhead (Shift+K)',
  })
  const follow = h('input', { type: 'checkbox' })
  follow.addEventListener('change', () => editor.setFollowCamera(follow.checked))

  const ease = h('select', { title: 'How the selected key travels to the next one' },
    h('option', { value: 'smooth' }, 'Smooth'),
    h('option', { value: 'linear' }, 'Linear'),
    h('option', { value: 'hold' }, 'Hold'),
  )
  ease.addEventListener('change', () => {
    if (selected) editor.setKeyEase(selected.key, ease.value as NonNullable<Keyframe['ease']>)
  })
  const removeKey = button('Delete key', () => deleteSelected(), { title: 'Delete the selected key (Delete)' })

  const bar = h('div', { class: 'tl-bar' },
    toStart,
    play,
    h('label', { class: 'tl-time', title: 'Playhead, in seconds' }, time, h('span', {}, '/'), duration, h('span', {}, 's')),
    h('label', { class: 'check' }, loop, 'Loop'),
    h('span', { class: 'sep' }),
    autoKey,
    keyObject,
    keyCamera,
    h('label', { class: 'check', title: 'Look through the animated camera. Off leaves the viewport free and draws the camera’s path.' }, follow, 'Through camera'),
    h('span', { class: 'spacer' }),
    h('label', { class: 'tl-key', title: 'The selected key' }, h('span', {}, 'Key'), ease),
    removeKey,
  )

  // ── ruler, rows, playhead ────────────────────────────────────────────────

  const rulerLane = h('div', { class: 'tl-lane tl-ruler' })
  const rows = h('div', { class: 'tl-rows' })
  const playhead = h('div', { class: 'tl-playhead' })
  const body = h('div', { class: 'tl-body' }, h('div', { class: 'tl-row tl-head' }, h('div', { class: 'tl-label' }), rulerLane), rows, playhead)
  root.append(bar, body)

  const fraction = (t: number) => (editor.animation.duration > 0 ? Math.min(Math.max(t / editor.animation.duration, 0), 1) : 0)
  /** The time under a pointer, measured against a lane */
  const timeAt = (lane: HTMLElement, clientX: number) => {
    const rect = lane.getBoundingClientRect()
    return rect.width > 0 ? ((clientX - rect.left) / rect.width) * editor.animation.duration : 0
  }

  /** Dragging along a lane's background moves the playhead. */
  function bindScrub(lane: HTMLElement) {
    let pointerId: number | null = null
    lane.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !editor.doc) return
      pointerId = e.pointerId
      try {
        lane.setPointerCapture(e.pointerId)
      } catch {
        // not an active pointer
      }
      editor.pause()
      editor.setTime(timeAt(lane, e.clientX))
    })
    lane.addEventListener('pointermove', (e) => {
      if (e.pointerId === pointerId) editor.setTime(timeAt(lane, e.clientX))
    })
    const end = (e: PointerEvent) => {
      if (e.pointerId === pointerId) pointerId = null
    }
    lane.addEventListener('pointerup', end)
    lane.addEventListener('pointercancel', end)
  }
  bindScrub(rulerLane)

  function select(next: typeof selected) {
    selected = next
    for (const node of rows.querySelectorAll<HTMLElement>('.tl-key-mark')) node.classList.remove('selected')
    syncSelection()
  }

  function deleteSelected(): boolean {
    if (!selected) return false
    const { target, key } = selected
    selected = null
    editor.removeKey(target, key)
    return true
  }

  function keyMark(lane: HTMLElement, target: string, key: Keyframe) {
    const mark = h('button', { type: 'button', class: 'tl-key-mark', title: `${trim(key.t, 2)} s` })
    mark.style.left = `${fraction(key.t) * 100}%`
    if (selected?.key === key) mark.classList.add('selected')

    let pointerId: number | null = null
    let startX = 0
    let dragging = false
    mark.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.stopPropagation()
      pointerId = e.pointerId
      startX = e.clientX
      dragging = false
      try {
        mark.setPointerCapture(e.pointerId)
      } catch {
        // not an active pointer
      }
      select({ target, key })
      mark.classList.add('selected')
    })
    mark.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId) return
      if (!dragging) {
        if (Math.abs(e.clientX - startX) < DRAG_SLOP) return
        dragging = true
        editor.pause()
        editor.beginKeyEdit()
      }
      const raw = timeAt(lane, e.clientX)
      editor.moveKey(target, key, e.shiftKey ? raw : Math.round(raw / SNAP) * SNAP)
      // moved by hand rather than by a redraw, which would drop the pointer mid-drag
      mark.style.left = `${fraction(key.t) * 100}%`
      mark.title = `${trim(key.t, 2)} s`
    })
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      pointerId = null
      if (dragging) editor.endKeyEdit()
      // a plain click on a key jumps the playhead to it
      else editor.setTime(key.t)
    }
    mark.addEventListener('pointerup', end)
    mark.addEventListener('pointercancel', end)
    return mark
  }

  /** Rebuild the ruler and the rows from the editor's tracks. */
  function render() {
    const { animation } = editor
    // a key that no longer exists (deleted, or replaced by an undo) cannot stay selected
    if (selected && !animation.tracks.some((track) => track.target === selected!.target && track.keys.includes(selected!.key))) selected = null

    const step = niceStep(animation.duration)
    const ticks: HTMLElement[] = []
    for (let t = 0; t <= animation.duration + 1e-6; t += step) {
      const tick = h('span', { class: 'tl-tick' }, trim(t, 1))
      tick.style.left = `${fraction(t) * 100}%`
      ticks.push(tick)
    }
    rulerLane.replaceChildren(...ticks)

    if (animation.tracks.length === 0) {
      rows.replaceChildren(
        h('p', { class: 'tl-empty fine' },
          editor.doc
            ? 'Nothing is animated yet. Move the playhead, then press K to key what you are editing (the splat, or the force or box you pressed Edit on), or Key camera to key the view. With Auto-key on, any change you make is keyed for you.'
            : 'Open a splat to animate it.'),
      )
    } else {
      rows.replaceChildren(
        ...animation.tracks.map((track) => {
          const lane = h('div', { class: 'tl-lane' })
          bindScrub(lane)
          // double-click on empty lane: a key there, with the value the track has at that time
          lane.addEventListener('dblclick', (e) => {
            if (e.target !== lane) return
            editor.setTime(timeAt(lane, e.clientX))
            editor.keyTrack(track.target)
          })
          lane.append(...track.keys.map((key) => keyMark(lane, track.target, key)))
          const label = h('div', { class: 'tl-label' },
            h('span', { title: track.target }, editor.trackLabel(track.target)),
            button('Add key', () => editor.keyTrack(track.target), { icon: icons.diamond, title: 'Add a key to this track at the playhead' }),
            button('Remove track', () => editor.removeTrack(track.target), { icon: icons.close, title: 'Remove this track and all its keys' }),
          )
          return h('div', { class: 'tl-row' }, label, lane)
        }),
      )
    }

    setValue(duration, trim(animation.duration, 2))
    loop.checked = animation.loop !== false
    autoKey.setAttribute('aria-pressed', String(editor.autoKey))
    follow.checked = editor.followCamera
    const hasDoc = !!editor.doc
    for (const control of [play, toStart, time, duration, loop, autoKey, keyObject, keyCamera, follow]) control.disabled = !hasDoc
    syncSelection()
    syncTime()
  }

  function syncSelection() {
    ease.disabled = removeKey.disabled = !selected
    if (selected && document.activeElement !== ease) ease.value = selected.key.ease ?? 'smooth'
  }

  /** The playhead moved: cheap, and called every frame during playback. */
  function syncTime() {
    playhead.style.setProperty('--at', String(fraction(editor.time)))
    setValue(time, editor.time.toFixed(2))
    const playing = editor.playing
    if (play.dataset.playing !== String(playing)) {
      play.dataset.playing = String(playing)
      play.innerHTML = playing ? icons.pause : icons.play
    }
  }

  editor.events.on('animation', render)
  editor.events.on('doc', render)
  editor.events.on('time', syncTime)
  render()

  return { deleteSelected }
}
