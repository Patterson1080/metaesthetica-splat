type Child = Node | string | null | undefined | false

type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], 'style' | 'dataset'>> & {
  class?: string
  style?: string
  data?: Record<string, string>
  attrs?: Record<string, string>
  on?: { [E in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[E]) => void }
}

/** Create an element: `h('button', { class: 'tool', on: { click } }, 'Label')`. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  const { class: className, style, data, attrs, on, ...rest } = props
  if (className) node.className = className
  if (style) node.style.cssText = style
  if (data) Object.assign(node.dataset, data)
  if (attrs) for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
  if (on) for (const [type, listener] of Object.entries(on)) node.addEventListener(type, listener as EventListener)
  Object.assign(node, rest)
  node.append(...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false))
  return node
}

/** Set an input's value unless the user is in the middle of typing into it. */
export const setValue = (input: HTMLInputElement, value: string) => {
  if (document.activeElement !== input && input.value !== value) input.value = value
}

export const trim = (n: number, digits = 3) => String(Math.round(n * 10 ** digits) / 10 ** digits)

const STORE_KEY = 'splat-editor-ui'

function store(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

/** A remembered interface choice (which tab, which groups are folded), or `fallback`. */
export function recall<T>(key: string, fallback: T): T {
  const value = store()[key]
  return (typeof value === typeof fallback ? value : fallback) as T
}

export function remember(key: string, value: unknown) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...store(), [key]: value }))
  } catch {
    // storage blocked: the choice still holds until the page reloads
  }
}

export interface GroupOptions {
  /** A sentence or two of explanation, kept behind a "?" so the group shows controls, not prose */
  help?: string
  /** Start folded. Whatever the user last chose wins over this. */
  closed?: boolean
  /** Key for remembering the folded state; defaults to the title */
  id?: string
}

/**
 * A collapsible group of related properties, like a panel in Blender's Properties editor.
 * It remembers whether it was left open.
 */
export function group(title: string, options: GroupOptions, ...children: Child[]) {
  const key = `group:${options.id ?? title}`
  const body = h('div', { class: 'group-body' }, ...children)
  const toggle = h('button', { type: 'button', class: 'group-toggle' })
  toggle.innerHTML = icons.chevron
  toggle.append(h('span', {}, title))
  const node = h('section', { class: 'group' })

  const setOpen = (open: boolean) => {
    node.classList.toggle('closed', !open)
    toggle.setAttribute('aria-expanded', String(open))
    body.hidden = !open
  }
  toggle.addEventListener('click', () => {
    const open = node.classList.contains('closed')
    setOpen(open)
    remember(key, open)
  })

  const head = h('header', { class: 'group-head' }, toggle)
  node.append(head)
  if (options.help) {
    const help = h('p', { class: 'group-help', hidden: true }, options.help)
    const about = h('button', { type: 'button', class: 'group-about', title: 'What is this?', attrs: { 'aria-expanded': 'false', 'aria-label': `About ${title}` } }, '?')
    about.addEventListener('click', () => {
      help.hidden = !help.hidden
      about.setAttribute('aria-expanded', String(!help.hidden))
      // an explanation asked for should not be hidden by a folded group
      if (!help.hidden) setOpen(true)
    })
    head.append(about)
    node.append(help)
  }
  node.append(body)
  setOpen(recall(key, !options.closed))
  return node
}

export function field(label: string, ...controls: Node[]) {
  return h('label', { class: 'field' }, h('span', {}, label), h('div', { class: 'controls' }, ...controls))
}

export function number(onCommit: (value: number) => void, props: { step?: number; min?: number; max?: number; title?: string } = {}) {
  const input = h('input', { type: 'number', step: String(props.step ?? 0.1), title: props.title ?? '' })
  if (props.min !== undefined) input.min = String(props.min)
  if (props.max !== undefined) input.max = String(props.max)
  input.addEventListener('change', () => {
    const value = Number(input.value)
    if (input.value !== '' && Number.isFinite(value)) onCommit(value)
  })
  // Enter commits and returns the keyboard to the viewport shortcuts
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur() })
  return input
}

export function button(label: string, onClick: () => void, props: { class?: string; title?: string; icon?: string } = {}) {
  const node = h('button', { type: 'button', class: props.class ?? '', title: props.title ?? '', on: { click: onClick } })
  if (props.icon) {
    node.innerHTML = props.icon
    node.setAttribute('aria-label', label)
    if (!props.title) node.title = label
  } else node.textContent = label
  return node
}

const svgIcon = (paths: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`

export const icons = {
  navigate: svgIcon('<path d="M5 3l14 8-6 2-2 6z"/>'),
  rect: svgIcon('<rect x="4" y="5" width="16" height="14" stroke-dasharray="3 2.5"/>'),
  lasso: svgIcon('<ellipse cx="12" cy="9.5" rx="8" ry="5.5" stroke-dasharray="3 2.5"/><path d="M8 14.5c-1.5 1-1.5 3 .5 3.5s2 2-.5 3"/>'),
  brush: svgIcon('<path d="M14.5 4.5l5 5L11 18l-5-5z"/><path d="M6 13c-2 1-3 3-2.5 6.5C7 20 9 19 11 18"/>'),
  move: svgIcon('<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>'),
  rotate: svgIcon('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/>'),
  scale: svgIcon('<path d="M4 20h7M4 20v-7M4 20l8-8"/><rect x="12" y="4" width="8" height="8"/>'),
  undo: svgIcon('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  redo: svgIcon('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
  frame: svgIcon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><circle cx="12" cy="12" r="2.5"/>'),
  play: svgIcon('<path d="M7 4.5v15l12-7.5z"/>'),
  close: svgIcon('<path d="M6 6l12 12M18 6L6 18"/>'),
  label: svgIcon('<circle cx="6" cy="17" r="1.6"/><path d="M7.2 15.8L12 11h8M14 15h6"/>'),
  pause: svgIcon('<path d="M8 5v14M16 5v14"/>'),
  toStart: svgIcon('<path d="M6 5v14"/><path d="M19 5l-9 7 9 7z"/>'),
  record: svgIcon('<circle cx="12" cy="12" r="5" fill="currentColor"/>'),
  diamond: svgIcon('<path d="M12 5l7 7-7 7-7-7z"/>'),
  chevron: svgIcon('<path d="M9 6l6 6-6 6"/>'),
  // the properties tabs
  tabEdit: svgIcon('<ellipse cx="12" cy="9.5" rx="8" ry="5.5" stroke-dasharray="3 2.5"/><path d="M8 14.5c-1.5 1-1.5 3 .5 3.5s2 2-.5 3"/>'),
  tabSplat: svgIcon('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>'),
  tabBoxes: svgIcon('<rect x="3.5" y="3.5" width="17" height="17" stroke-dasharray="3 2.5"/><rect x="8.5" y="8.5" width="7" height="7"/>'),
  tabForces: svgIcon('<path d="M3 8c3-3 6-3 9 0s6 3 9 0M3 15c3-3 6-3 9 0s6 3 9 0"/>'),
  tabCamera: svgIcon('<rect x="3" y="7" width="13" height="10" rx="1.5"/><path d="M16 10.5l5-2.5v8l-5-2.5z"/>'),
  tabPlayer: svgIcon('<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M10 9.5v5l4.5-2.5z"/>'),
  tabExport: svgIcon('<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>'),
}
