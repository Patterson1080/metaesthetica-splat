type Listener = (...args: unknown[]) => void

/** Minimal typed event emitter. `on` returns the function that removes the listener. */
export class Emitter<Events extends Record<string, unknown[]>> {
  private listeners = new Map<keyof Events, Set<Listener>>()

  on<K extends keyof Events>(type: K, listener: (...args: Events[K]) => void): () => void {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    const stored = listener as unknown as Listener
    set.add(stored)
    return () => set.delete(stored)
  }

  emit<K extends keyof Events>(type: K, ...args: Events[K]) {
    // copy: a listener may unsubscribe itself while being called
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(...args)
  }

  clear() {
    this.listeners.clear()
  }
}
