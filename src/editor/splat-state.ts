import { PIXELFORMAT_R8, type GSplatComponent, type GSplatResourceBase, type Texture } from 'playcanvas'
import type { SplatEffects } from '../core/effects'

/** Per-splat flags. A deleted splat is never also selected. */
export const SELECTED = 1
export const DELETED = 2

const STREAM = 'splatState'

/**
 * The edit state of one splat: which gaussians are selected or deleted. The flags live in
 * one extra byte-per-splat texture stream, which the splat's work-buffer hook (SplatEffects,
 * created with `editState`) reads to hide deleted splats and tint selected ones. An edit is
 * therefore a single small texture upload; nothing is rebuilt.
 *
 * Mutate `flags` freely, then call `commit()` once.
 */
export class SplatState {
  readonly flags: Uint8Array
  selected = 0
  deleted = 0

  private readonly texture: Texture
  private readonly effects: SplatEffects

  /** Reserve the flags stream. Must run after the file is parsed and before its first draw. */
  static declare(resource: GSplatResourceBase) {
    resource.format.addExtraStreams([{ name: STREAM, format: PIXELFORMAT_R8 }])
  }

  constructor(resource: GSplatResourceBase, component: GSplatComponent, effects: SplatEffects) {
    const texture = resource.getTexture(STREAM)
    if (!texture) throw new Error('Splat state stream was not declared before the splat was created')
    this.texture = texture
    this.effects = effects
    this.flags = new Uint8Array(resource.numSplats)
    component.setParameter('uSelectTint', [1, 0.78, 0.1, 0.8])
    this.commit()
  }

  get count() {
    return this.flags.length
  }

  /** Splats that survive: what an export will contain */
  get remaining() {
    return this.flags.length - this.deleted
  }

  /** Push `flags` to the GPU and refresh the counters. */
  commit() {
    const { flags } = this
    let selected = 0
    let deleted = 0
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i]
      if (f & DELETED) deleted++
      else if (f & SELECTED) selected++
    }
    this.selected = selected
    this.deleted = deleted

    // the texture is padded to a rectangle, so it holds at least `flags.length` texels
    const pixels = this.texture.lock() as Uint8Array
    pixels.set(flags)
    this.texture.unlock()
    this.effects.touch()
  }
}
