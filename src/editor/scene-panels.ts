import { FORCE_DEFAULTS, FORCE_TYPES, drawsPoints, type Force, type ForceType, type SectionBox, type Vec3Tuple } from '../core/scene'
import { button, field, group, h, icons, number, setValue, trim } from './dom'
import type { ActiveObject, Editor } from './editor'

const AXES = ['X', 'Y', 'Z'] as const

/** Three number inputs editing one vector. */
function vec3Row(label: string, step: number, commit: (value: Vec3Tuple) => void) {
  let current: Vec3Tuple = [0, 0, 0]
  const inputs = AXES.map((axis, i) =>
    number(
      (value) => {
        const next: Vec3Tuple = [...current]
        next[i] = value
        commit(next)
      },
      { step, title: `${label} ${axis}` },
    ),
  )
  return {
    node: field(label, ...inputs),
    set(value: Vec3Tuple) {
      current = value
      inputs.forEach((input, i) => setValue(input, trim(value[i])))
    },
  }
}

interface ListOptions<T> {
  kind: ActiveObject['kind']
  items: () => T[]
  kinds: [value: string, label: string][]
  kindOf: (item: T) => string
  setKind: (index: number, value: string) => void
  rename: (index: number, name: string) => void
  enable: (index: number, enabled: boolean) => void
  remove: (index: number) => void
}

/**
 * The rows shared by section boxes and forces: on/off, name, kind, "point the gizmo at
 * this", remove. Rows are rebuilt only when their number changes; otherwise values are
 * updated in place, so typing in one field never throws away the control you are about to
 * click next.
 */
function objectList<T extends { name?: string; enabled?: boolean }>(editor: Editor, options: ListOptions<T>) {
  const node = h('ul', { class: 'objects' })
  let rows: { enabled: HTMLInputElement; name: HTMLInputElement; kind: HTMLSelectElement; edit: HTMLButtonElement; node: HTMLElement }[] = []

  const isActive = (index: number) => editor.active?.kind === options.kind && editor.active.index === index

  function build(count: number) {
    rows = Array.from({ length: count }, (_, i) => {
      const enabled = h('input', { type: 'checkbox', title: 'Switch on or off' })
      enabled.addEventListener('change', () => options.enable(i, enabled.checked))
      const name = h('input', { type: 'text', spellcheck: false, attrs: { 'aria-label': 'Name' } })
      name.addEventListener('change', () => options.rename(i, name.value.trim()))
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur() })
      const kind = h('select', { title: 'Kind' }, ...options.kinds.map(([value, label]) => h('option', { value }, label)))
      kind.addEventListener('change', () => options.setKind(i, kind.value))
      const edit = button('Edit', () => editor.setActive(isActive(i) ? null : { kind: options.kind, index: i }), {
        title: 'Point the move, rotate and scale tools at this instead of the splat',
      })
      const remove = button('Remove', () => options.remove(i), { icon: icons.close })
      return { enabled, name, kind, edit, node: h('li', {}, enabled, name, kind, edit, remove) }
    })
    node.replaceChildren(...rows.map((row) => row.node))
  }

  return {
    node,
    sync() {
      const items = options.items()
      if (rows.length !== items.length) build(items.length)
      items.forEach((item, i) => {
        const row = rows[i]
        row.enabled.checked = item.enabled !== false
        setValue(row.name, item.name ?? '')
        if (document.activeElement !== row.kind) row.kind.value = options.kindOf(item)
        row.edit.setAttribute('aria-pressed', String(isActive(i)))
      })
    },
  }
}

/** The groups for what lives in the scene besides the splat: section boxes, forces and labels, one list per tab. */
export function buildScenePanels(editor: Editor) {
  // `editor.settings` is replaced whenever a file opens, so it is read fresh in every handler

  // ── section boxes ────────────────────────────────────────────────────────

  const activeSection = () => (editor.active?.kind === 'section' ? editor.active.index : null)
  const sectionList = objectList<SectionBox>(editor, {
    kind: 'section',
    items: () => editor.settings.sections,
    kinds: [['keep', 'Keep inside'], ['cut', 'Cut away']],
    kindOf: (box) => box.mode ?? 'keep',
    setKind: (i, mode) => editor.updateSection(i, { mode: mode as SectionBox['mode'] }),
    rename: (i, name) => editor.updateSection(i, { name }),
    enable: (i, enabled) => editor.updateSection(i, { enabled }),
    remove: (i) => editor.removeSection(i),
  })
  const editSection = (patch: Partial<SectionBox>) => {
    const index = activeSection()
    if (index !== null) editor.updateSection(index, patch)
  }
  const sectionRows = {
    position: vec3Row('Position', 0.1, (position) => editSection({ position })),
    rotation: vec3Row('Rotation', 5, (rotation) => editSection({ rotation })),
    size: vec3Row('Size', 0.1, (size) => editSection({ size: size.map((v) => Math.max(v, 0.001)) as Vec3Tuple })),
  }
  // a box can stand for a component of the splat: its name becomes a title, this its description
  const boxLabel = h('input', { type: 'checkbox' })
  boxLabel.addEventListener('change', () => editSection({ label: boxLabel.checked }))
  const boxText = h('textarea', { rows: 3, spellcheck: true, placeholder: 'Description shown under the box (optional)' })
  boxText.addEventListener('change', () => editSection({ text: boxText.value }))
  const nothingToEdit = (what: string) => h('p', { class: 'fine' }, `Press Edit on a ${what} above to see its properties here.`)
  const boxPlacement = group('Placement', { id: 'box-placement' }, sectionRows.position.node, sectionRows.rotation.node, sectionRows.size.node)
  const boxLabelGroup = group(
    'Label',
    { id: 'box-label', help: 'Presents the box as a named component: the player outlines it and sets its name above it and this description below.' },
    h('label', { class: 'check' }, boxLabel, 'Show as a labelled component'),
    boxText,
  )
  const noBox = nothingToEdit('box')

  // what the boxes leave out: faded, or not drawn at all
  const restSlider = h('input', { type: 'range', min: '0', max: '1', step: '0.01', title: 'How visible the splats outside the boxes stay' })
  const restValue = h('output', {})
  restSlider.addEventListener('input', () => {
    restValue.textContent = Number(restSlider.value).toFixed(2)
    editor.previewSectionRest(Number(restSlider.value))
  })
  restSlider.addEventListener('change', () => editor.commitSectionRest())
  const restHide = button('Hide the rest', () => editor.setSectionRest({ hidden: !editor.settings.sectionRest.hidden }), {
    title: 'Stop drawing the splats outside the boxes altogether',
  })
  const bake = button('Delete the rest', () => editor.bakeSections(), {
    class: 'danger',
    title: 'Make the cut permanent: delete every splat outside the boxes, faded or hidden. The export gets smaller; the boxes can then be removed.',
  })
  const boxList = group(
    'Boxes',
    { help: 'Boxes single out part of the splat without deleting anything, and the player can switch them off. In full view is what lies inside any keep box, minus what lies inside any cut box. Press Edit to move, rotate and scale a box with tools 1, 2 and 3.' },
    sectionList.node,
    h('div', { class: 'row' }, button('+ Keep box', () => editor.addSection('keep')), button('+ Cut box', () => editor.addSection('cut'))),
    noBox,
  )
  const restGroup = group(
    'Rest of the splat',
    { help: 'What the boxes leave out can stay faintly visible, or not be drawn at all. Delete the rest makes the cut permanent.' },
    field('Opacity', restSlider, restValue),
    h('div', { class: 'row' }, restHide, bake),
  )

  // ── forces ───────────────────────────────────────────────────────────────

  const activeForce = () => (editor.active?.kind === 'force' ? editor.active.index : null)
  const forceList = objectList<Force>(editor, {
    kind: 'force',
    items: () => editor.settings.forces,
    kinds: FORCE_TYPES.map((type) => [type, type[0].toUpperCase() + type.slice(1)] as [string, string]),
    kindOf: (force) => force.type,
    setKind: (i, type) => editor.updateForce(i, { type: type as ForceType }),
    rename: (i, name) => editor.updateForce(i, { name }),
    enable: (i, enabled) => editor.updateForce(i, { enabled }),
    remove: (i) => editor.removeForce(i),
  })
  const editForce = (patch: Partial<Force>) => {
    const index = activeForce()
    if (index !== null) editor.updateForce(index, patch)
  }
  const forceVec = {
    position: vec3Row('Position', 0.1, (position) => editForce({ position })),
    rotation: vec3Row('Rotation', 5, (rotation) => editForce({ rotation })),
  }

  type NumericKey = 'radius' | 'strength' | 'amount' | 'cycle' | 'dotSize' | 'tint' | 'noise' | 'noiseScale' | 'lift' | 'pull'
  const params: { key: NumericKey; label: string; title: string; step: number; min?: number; max?: number; slider?: boolean; only?: ForceType; when?: (force: Force) => boolean }[] = [
    { key: 'radius', label: 'Reach', title: 'How far the force reaches, in world units. Its hold fades to nothing at this distance.', step: 0.1, min: 0.001 },
    { key: 'strength', label: 'Strength', title: 'Speed of the motion', step: 1 },
    { key: 'amount', label: 'Share moving', title: 'Share of the splats in reach that the force carries. At 1 the whole splat in reach flows; lower values leave the rest in place to hold the form.', step: 0.01, min: 0, max: 1, slider: true },
    { key: 'cycle', label: 'Travel time', title: 'Seconds a splat travels before it fades and starts again from home', step: 0.5, min: 0.1 },
    { key: 'dotSize', label: 'Point size', title: 'Size of the points, in world units', step: 0.002, min: 0.0005, when: drawsPoints },
    { key: 'tint', label: 'Tint', title: 'Optional look: how far the color below replaces each moving splat’s own color. 0 (default) keeps its own color.', step: 0.01, min: 0, max: 1, slider: true },
    { key: 'noise', label: 'Wander', title: 'Extra wandering laid over the motion, in world units per second', step: 0.01, min: 0 },
    { key: 'noiseScale', label: 'Eddy size', title: 'Size of the wander’s eddies, in world units', step: 0.1, min: 0.001 },
    { key: 'lift', label: 'Lift', title: 'Drift along the swirl’s axis, in world units per second', step: 0.01, only: 'swirl' },
    { key: 'pull', label: 'Pull in', title: 'Drift toward the swirl’s axis, in world units per second. Negative flings outward.', step: 0.01, only: 'swirl' },
  ]
  const strengthUnits: Record<ForceType, string> = { swirl: 'Speed °/s', wind: 'Speed', attract: 'Pull 1/s', turbulence: 'Speed' }
  const paramRows = params.map((param) => {
    const output = h('output', {})
    const input = param.slider
      ? h('input', { type: 'range', min: String(param.min), max: String(param.max), step: String(param.step), title: param.title })
      : number((value) => editForce({ [param.key]: value }), param)
    if (param.slider) {
      input.addEventListener('input', () => (output.textContent = Number(input.value).toFixed(2)))
      // one undo step per drag, taken when the slider is released
      input.addEventListener('change', () => editForce({ [param.key]: Number(input.value) }))
    }
    const label = h('span', {}, param.label)
    const node = h('label', { class: 'field', title: param.title }, label, h('div', { class: 'controls' }, input, param.slider ? output : null))
    return { ...param, input, output, label, node }
  })
  const color = h('input', { type: 'color', title: 'Tint color for moving splats (only shows when Tint is above 0)' })
  color.addEventListener('change', () => editForce({ color: color.value }))
  const drawAs = h('select', { title: 'How the splats this force carries are drawn' },
    h('option', { value: 'splats' }, 'Splats (own shape)'),
    h('option', { value: 'points' }, 'Points only'),
  )
  drawAs.addEventListener('change', () => editForce({ render: drawAs.value as Force['render'] }))
  const drawRow = field('Draw as', drawAs)
  drawRow.title = 'Splats: each moving splat keeps its own shape. Points: moving splats are drawn as plain round points of one size.'
  // a force's dozen properties, in the three questions they answer: where, how it moves, how it looks
  const rowOf = (key: NumericKey) => paramRows.find((row) => row.key === key)!.node
  const forcePlacement = group('Placement', { id: 'force-placement' }, forceVec.position.node, forceVec.rotation.node, rowOf('radius'))
  const forceMotion = group(
    'Motion',
    { id: 'force-motion', help: 'Strength is the speed of the motion. Share moving below 1 leaves the rest of the splats in place to hold the form. Travel time is how long a splat flows before it fades and starts again from home. Wander adds irregularity.' },
    rowOf('strength'), rowOf('amount'), rowOf('cycle'), rowOf('noise'), rowOf('noiseScale'), rowOf('lift'), rowOf('pull'),
  )
  const forceLook = group(
    'Look',
    { id: 'force-look', help: 'Draw what the force carries as splats in their own shape, or as plain round points. Tint above 0 gives them the color.' },
    drawRow, rowOf('dotSize'), rowOf('tint'), field('Color', color),
  )
  const noForce = nothingToEdit('force')

  const preview = h('input', { type: 'checkbox' })
  preview.addEventListener('change', () => editor.setFlowPreview(preview.checked))
  const forceGroup = group(
    'Forces',
    { help: 'A force moves the splat’s own points: those in its reach travel along it, fade and start again from home. Nothing is added. Press Edit to move a force with tools 1, 2 and 3 (scale changes its reach); its spine is the swirl axis or wind direction. Forces rest while a selection tool is in use, and are only layered correctly on WebGPU.' },
    forceList.node,
    h('div', { class: 'row add-kinds' }, ...FORCE_TYPES.map((type) => button(`+ ${type[0].toUpperCase()}${type.slice(1)}`, () => editor.addForce(type)))),
    h('label', { class: 'check' }, preview, 'Run forces in the viewport'),
    noForce,
  )

  // ── labels ───────────────────────────────────────────────────────────────

  const labelList = h('ul', { class: 'objects' })
  let labelRows: { title: HTMLInputElement; node: HTMLElement }[] = []
  const body = h('textarea', { rows: 3, spellcheck: true, placeholder: 'Text under the title (optional)' })
  body.addEventListener('change', () => {
    if (editor.activeAnnotation !== null) editor.updateAnnotation(editor.activeAnnotation, { text: body.value })
  })
  const labelGroup = group(
    'Labels',
    { help: 'With the Label tool, click the splat to pin a label there. Drag its text to move it, drag its dot to re-pin it. Labels are plain text over the splat with no background; the player can hide them.' },
    labelList,
    h('div', { class: 'row' }, button('Place labels', () => editor.setTool('annotate'), { title: 'Switch to the Label tool (A)' })),
  )
  const labelDetail = group('Text', { id: 'label-text' }, body)

  function syncLabels() {
    const { annotations } = editor.settings
    if (labelRows.length !== annotations.length) {
      labelRows = annotations.map((_, i) => {
        const title = h('input', { type: 'text', spellcheck: false, placeholder: 'Title', attrs: { 'aria-label': `Title of label ${i + 1}` } })
        title.addEventListener('focus', () => editor.setActiveAnnotation(i))
        title.addEventListener('change', () => editor.updateAnnotation(i, { title: title.value.trim() }))
        title.addEventListener('keydown', (e) => { if (e.key === 'Enter') title.blur() })
        const node = h('li', {},
          title,
          button('Go', () => { editor.setActiveAnnotation(i); editor.lookAtAnnotation(i) }, { title: 'Orbit around this label’s point' }),
          button('Remove label', () => editor.removeAnnotation(i), { icon: icons.close }),
        )
        return { title, node }
      })
      labelList.replaceChildren(...labelRows.map((row) => row.node))
    }
    annotations.forEach((annotation, i) => {
      setValue(labelRows[i].title, annotation.title ?? '')
      labelRows[i].node.classList.toggle('active', editor.activeAnnotation === i)
    })
    const active = editor.activeAnnotation === null ? null : annotations[editor.activeAnnotation]
    labelDetail.hidden = !active
    if (active && document.activeElement !== body) body.value = active.text ?? ''
  }

  function sync() {
    sectionList.sync()
    const box = activeSection() === null ? null : editor.settings.sections[activeSection()!]
    boxPlacement.hidden = boxLabelGroup.hidden = !box
    noBox.hidden = !!box || editor.settings.sections.length === 0
    if (box) {
      sectionRows.position.set(box.position)
      sectionRows.rotation.set(box.rotation)
      sectionRows.size.set(box.size)
      boxLabel.checked = box.label === true
      boxText.disabled = box.label !== true
      if (document.activeElement !== boxText) boxText.value = box.text ?? ''
    }
    const anyBox = editor.settings.sections.some((s) => s.enabled !== false)
    bake.disabled = !anyBox
    const rest = editor.settings.sectionRest
    restGroup.hidden = editor.settings.sections.length === 0
    restSlider.disabled = rest.hidden
    setValue(restSlider, String(rest.opacity))
    restValue.textContent = rest.opacity.toFixed(2)
    restHide.textContent = rest.hidden ? 'Show the rest' : 'Hide the rest'
    restHide.setAttribute('aria-pressed', String(rest.hidden))

    forceList.sync()
    const force = activeForce() === null ? null : editor.settings.forces[activeForce()!]
    forcePlacement.hidden = forceMotion.hidden = forceLook.hidden = !force
    noForce.hidden = !!force || editor.settings.forces.length === 0
    if (force) {
      forceVec.position.set(force.position)
      forceVec.rotation.set(force.rotation ?? [0, 0, 0])
      for (const row of paramRows) {
        row.node.hidden = (row.only !== undefined && row.only !== force.type) || (row.when !== undefined && !row.when(force))
        const fallback = (FORCE_DEFAULTS as Record<string, number | string>)[row.key]
        const value = force[row.key] ?? (typeof fallback === 'number' ? fallback : 0)
        setValue(row.input, trim(value, 4))
        if (row.slider) row.output.textContent = value.toFixed(2)
        if (row.key === 'strength') row.label.textContent = strengthUnits[force.type]
      }
      setValue(color, force.color ?? FORCE_DEFAULTS.color)
      if (document.activeElement !== drawAs) drawAs.value = drawsPoints(force) ? 'points' : 'splats'
    }
    preview.checked = editor.flowPreview

    syncLabels()
  }

  return {
    boxes: [boxList, boxPlacement, boxLabelGroup, restGroup],
    forces: [forceGroup, forcePlacement, forceMotion, forceLook],
    labels: [labelGroup, labelDetail],
    sync,
  }
}
