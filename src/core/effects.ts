import { BoundingBox, WORKBUFFER_UPDATE_ALWAYS, WORKBUFFER_UPDATE_ONCE, type GSplatComponent } from 'playcanvas'
import { activeForces, forceChunk, maxDisplacement, setForceUniforms, type ActiveForces } from './forces'
import type { Force, SectionBox } from './scene'
import { activeSections, sectionChunk, setSectionUniforms, type ActiveSections } from './sections'

export interface EffectOptions {
  /**
   * The editor's per-splat flags stream (selected / deleted) is present and should be
   * honored. The stream itself is declared and filled by the editor.
   */
  editState?: boolean
}

/**
 * The engine copies every splat into a "work buffer" before drawing and lets a component
 * hook into that copy to move, resize and recolor splats. This class owns that hook for
 * one splat and builds it from whatever the scene asks for: force fields (which move
 * splats), section boxes (which hide them) and, in the editor, the edit flags.
 *
 * Kinds and counts are baked into the shader source and everything else is a uniform, so
 * dragging a box or tuning a force never recompiles; adding or removing one does.
 */
export class SplatEffects {
  private sections: ActiveSections = activeSections([])
  private forces: ActiveForces = activeForces([])
  private key: string | null = null
  private time = 0
  private rest = 0
  private reach = -1
  private readonly ownBounds: BoundingBox | null

  constructor(
    private readonly component: GSplatComponent,
    private readonly options: EffectOptions = {},
  ) {
    this.ownBounds = component.customAabb?.clone() ?? null
    this.apply()
  }

  /** True while a force is running: the splat then needs redrawing every frame */
  get animated() {
    return this.forces.types.length > 0
  }

  /** `rest` is how visible the splats outside the boxes stay: 0 drops them, up to 1 leaves them as they are. */
  setSections(sections: readonly SectionBox[], rest = 0) {
    this.sections = activeSections(sections)
    this.rest = Math.min(Math.max(rest, 0), 1)
    this.apply()
  }

  setForces(forces: readonly Force[]) {
    this.forces = activeForces(forces)
    // splats carried outside the splat's own bounds must not be culled with them
    const reach = maxDisplacement(forces)
    if (this.ownBounds && Math.abs(reach - this.reach) > 1e-3) {
      this.reach = reach
      const bounds = this.ownBounds.clone()
      bounds.halfExtents.x += reach
      bounds.halfExtents.y += reach
      bounds.halfExtents.z += reach
      this.component.customAabb = bounds
    }
    this.apply()
  }

  /** Move the flow clock on. Returns true when that changed the picture. */
  advance(dt: number): boolean {
    if (!this.animated) return false
    this.time += dt
    this.component.setParameter('uFlowTime', this.time)
    return true
  }

  /** Something the hook reads has changed (the edit flags): redraw the work buffer once. */
  touch() {
    if (!this.animated) this.component.workBufferUpdate = WORKBUFFER_UPDATE_ONCE
  }

  private apply() {
    const { component, sections, forces } = this
    const key = `${sections.key}|${forces.key}`
    if (key !== this.key) {
      const idle = sections.modes.length === 0 && forces.types.length === 0 && !this.options.editState
      // nothing to do and nothing set: leave the splat on the engine's untouched fast path
      if (!(idle && this.key === null)) component.setWorkBufferModifier(idle ? null : this.build())
      this.key = key
    }
    setSectionUniforms(component, sections, this.rest)
    setForceUniforms(component, forces)
    component.setParameter('uFlowTime', this.time)
    component.workBufferUpdate = this.animated ? WORKBUFFER_UPDATE_ALWAYS : WORKBUFFER_UPDATE_ONCE
  }

  private build() {
    const section = sectionChunk(this.sections.modes)
    const force = forceChunk(this.forces.types)
    const edit = this.options.editState === true

    const glsl = `
${edit ? 'uniform vec4 uSelectTint;' : ''}
${section.glsl}
${force.glsl}
// quaternion product, (x, y, z, w)
vec4 flowQuatMul(vec4 a, vec4 b) {
    return vec4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}
void modifySplatCenter(inout vec3 center) {
    applyForces(center);
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    if (${edit ? 'loadSplatState().r * 255.0 > 1.5 || ' : ''}sectionKeep(modifiedCenter) <= 0.0) {
        scale = vec3(0.0);
        return;
    }
    if (flowLoose > 0.5) {
        if (flowDot > 0.0) {
            // optional look: carried splats drawn as round dots, whatever shape they had
            scale = vec3(flowDot);
            rotation = vec4(0.0, 0.0, 0.0, 1.0);
        } else {
            // by default a carried splat keeps its own shape and turns with the current
            rotation = flowQuatMul(flowSpin, rotation);
        }
        scale *= flowFade;
    }
}

void modifySplatColor(vec3 center, inout vec4 color) {
    ${edit ? 'float state = loadSplatState().r * 255.0;' : ''}
    float keep = sectionKeep(center);
    if (${edit ? 'state > 1.5 || ' : ''}keep <= 0.0) {
        color.a = 0.0;
        return;
    }
    if (flowLoose > 0.5) {
        color.rgb = mix(color.rgb, flowTint.rgb, flowTint.a);
        // dots read as points of light, so they are made solid; splats keeping their shape keep their own opacity
        color.a = (flowDot > 0.0 ? max(color.a, 0.85) : color.a) * flowFade;
    }
    ${edit ? `if (state > 0.5) {
        color.rgb = mix(color.rgb, uSelectTint.rgb, uSelectTint.a);
        // faint splats must stay visible while selected, or they cannot be judged before deleting
        color.a = max(color.a, 0.35);
    }` : ''}
    // what the section boxes leave out is faded, not dropped, when the scene asks for that
    color.a *= keep;
}
`

    const wgsl = `
${edit ? 'uniform uSelectTint: vec4f;' : ''}
${section.wgsl}
${force.wgsl}
fn flowQuatMul(a: vec4f, b: vec4f) -> vec4f {
    return vec4f(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}
fn modifySplatCenter(center: ptr<function, vec3f>) {
    applyForces(center);
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    if (${edit ? 'loadSplatState().r * 255.0 > 1.5 || ' : ''}sectionKeep(modifiedCenter) <= 0.0) {
        *scale = vec3f(0.0);
        return;
    }
    if (flowLoose > 0.5) {
        if (flowDot > 0.0) {
            *scale = vec3f(flowDot);
            *rotation = vec4f(0.0, 0.0, 0.0, 1.0);
        } else {
            *rotation = flowQuatMul(flowSpin, *rotation);
        }
        *scale = (*scale) * flowFade;
    }
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    ${edit ? 'let state = loadSplatState().r * 255.0;' : ''}
    let keep = sectionKeep(center);
    if (${edit ? 'state > 1.5 || ' : ''}keep <= 0.0) {
        (*color).a = 0.0;
        return;
    }
    if (flowLoose > 0.5) {
        let alpha = select((*color).a, max((*color).a, 0.85), flowDot > 0.0);
        *color = vec4f(mix((*color).rgb, flowTint.rgb, flowTint.a), alpha * flowFade);
    }
    ${edit ? `if (state > 0.5) {
        *color = vec4f(mix((*color).rgb, uniform.uSelectTint.rgb, uniform.uSelectTint.a), max((*color).a, 0.35));
    }` : ''}
    (*color).a = (*color).a * keep;
}
`
    return { glsl, wgsl }
  }
}
