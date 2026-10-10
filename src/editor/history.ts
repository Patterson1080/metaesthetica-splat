export interface Command {
  label: string
  undo(): void
  redo(): void
}

const LIMIT = 200

/** Linear undo stack. Commands are pushed already applied. */
export class History {
  onChange: (() => void) | null = null
  private done: Command[] = []
  private undone: Command[] = []

  get canUndo() {
    return this.done.length > 0
  }

  get canRedo() {
    return this.undone.length > 0
  }

  get undoLabel() {
    return this.done[this.done.length - 1]?.label ?? null
  }

  get redoLabel() {
    return this.undone[this.undone.length - 1]?.label ?? null
  }

  push(command: Command) {
    this.done.push(command)
    if (this.done.length > LIMIT) this.done.shift()
    this.undone.length = 0
    this.onChange?.()
  }

  undo() {
    const command = this.done.pop()
    if (!command) return
    command.undo()
    this.undone.push(command)
    this.onChange?.()
  }

  redo() {
    const command = this.undone.pop()
    if (!command) return
    command.redo()
    this.done.push(command)
    this.onChange?.()
  }

  clear() {
    this.done.length = 0
    this.undone.length = 0
    this.onChange?.()
  }
}

/**
 * The smallest record of a change to a byte array: which entries changed, and their values
 * before and after. Returns null when nothing changed.
 */
export function diffBytes(before: Uint8Array, after: Uint8Array) {
  let count = 0
  for (let i = 0; i < after.length; i++) if (before[i] !== after[i]) count++
  if (count === 0) return null
  const indices = new Uint32Array(count)
  const from = new Uint8Array(count)
  const to = new Uint8Array(count)
  for (let i = 0, n = 0; i < after.length; i++) {
    if (before[i] !== after[i]) {
      indices[n] = i
      from[n] = before[i]
      to[n] = after[i]
      n++
    }
  }
  return { indices, from, to }
}
