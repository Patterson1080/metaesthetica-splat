/**
 * Player chrome, scoped inside the shadow root so the host page's CSS (resets, Tailwind
 * preflight, link styles) cannot reach it and it cannot leak out. Custom properties still
 * inherit through the boundary, which is how a page themes it:
 *
 *   --splat-bg        stage color behind the splat and poster   (default #000). With a
 *                     transparent background, set it to the color the player sits on:
 *                     the control scrims are mixed from it.
 *   --splat-fg        text and icon color                       (default #fff)
 *   --splat-accent    focus ring and progress bar               (default: --splat-fg)
 *   --splat-radius    corner radius of the stage                (default 0)
 */
import { annotationCss } from '../core/annotations'

export const playerCss = /* css */ `
:host {
  display: block;
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  container-type: inline-size;
  border-radius: var(--splat-radius, 0);
  background: var(--splat-bg, #000);
  color: var(--splat-fg, #fff);
  font: inherit;
  font-size: 13px;
  line-height: 1.4;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  -webkit-user-select: none;
}
:host([data-transparent]) { background: transparent; }
:host(:fullscreen) { border-radius: 0; background: var(--splat-bg, #000); }

canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  outline: none;
  cursor: grab;
  /* until the viewer taps in, a vertical swipe still scrolls the page */
  touch-action: pan-y;
  opacity: 0;
  transition: opacity 500ms ease;
}
canvas:active { cursor: grabbing; }
:host([data-active]) canvas { touch-action: none; }
:host([data-state="ready"]) canvas { opacity: 1; }

.poster {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
  transition: opacity 500ms ease;
}
:host([data-state="ready"]) .poster { opacity: 0; }

button {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: inherit;
  font: inherit;
}
button:focus-visible, canvas:focus-visible {
  outline: 2px solid var(--splat-accent, var(--splat-fg, #fff));
  outline-offset: -2px;
}
svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }

/* controls sit on a soft scrim so they stay legible over any splat */
.bar {
  position: absolute;
  bottom: 10px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  background: color-mix(in srgb, var(--splat-bg, #000) 55%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  opacity: 0;
  transition: opacity 200ms ease;
  pointer-events: none;
}
.bar.end { right: 10px; }
.bar.start { left: 10px; }
.bar.middle { left: 50%; transform: translateX(-50%); gap: 6px; padding-right: 10px; }
.bar.middle input[type="range"] { width: clamp(90px, 22cqw, 260px); height: 18px; margin: 0; accent-color: var(--splat-accent, var(--splat-fg, #fff)); cursor: pointer; }
/* in a narrow player the three bars cannot share a line, so the transport takes the one above */
@container (max-width: 600px) { .bar.middle { bottom: 56px; } }
/* the transport sits where the hint would; an animated scene explains itself */
:host([data-animated]) .hint { display: none; }
:host([data-state="ready"]) .bar { opacity: 0.85; pointer-events: auto; }
:host([data-state="ready"]) .bar:hover, :host([data-state="ready"]) .bar:focus-within { opacity: 1; }
.bar[hidden] { display: none; }
.bar button { width: 34px; height: 34px; opacity: 0.8; }
.bar button:hover { opacity: 1; }
.bar button[hidden] { display: none; }
/* a toggle that is switched off reads as dimmed */
.bar button[aria-pressed="false"] { opacity: 0.4; }
.bar button[aria-pressed="false"]:hover { opacity: 0.75; }
.bar .label { padding: 0 8px 0 4px; font-variant-numeric: tabular-nums; white-space: nowrap; max-width: 14em; overflow: hidden; text-overflow: ellipsis; }

.hint {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  padding: 6px 12px;
  white-space: nowrap;
  background: color-mix(in srgb, var(--splat-bg, #000) 55%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  opacity: 0;
  transition: opacity 400ms ease;
  pointer-events: none;
}
:host([data-state="ready"][data-hint]) .hint { opacity: 0.9; }
/* narrow tiles have no room for a hint between the two bars */
@container (max-width: 520px) { .hint { bottom: 56px; } }

.center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 16px;
  text-align: center;
  pointer-events: none;
}
.center > * { pointer-events: auto; }
.center[hidden] { display: none; }

.start-button {
  gap: 8px;
  padding: 10px 16px 10px 12px;
  background: color-mix(in srgb, var(--splat-bg, #000) 60%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid color-mix(in srgb, var(--splat-fg, #fff) 35%, transparent);
}
.start-button:hover { border-color: var(--splat-fg, #fff); }

.progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: color-mix(in srgb, var(--splat-fg, #fff) 18%, transparent);
  opacity: 0;
  transition: opacity 300ms ease;
  pointer-events: none;
}
:host([data-state="loading"]) .progress { opacity: 1; }
.progress > i {
  display: block;
  height: 100%;
  width: 0%;
  background: var(--splat-accent, var(--splat-fg, #fff));
  transition: width 200ms linear;
}
.progress.indeterminate > i { width: 30%; animation: slide 1.1s ease-in-out infinite alternate; }
@keyframes slide { from { margin-left: 0; } to { margin-left: 70%; } }

.status { opacity: 0.8; font-variant-numeric: tabular-nums; }
.error { max-width: 32em; }

.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* callouts belong to the splat: they fade in with it, never over the poster */
.sa-layer { opacity: 0; transition: opacity 500ms ease; }
:host([data-state="ready"]) .sa-layer { opacity: 1; }
${annotationCss}

@media (prefers-reduced-motion: reduce) {
  canvas, .poster, .bar, .hint, .progress, .sa-layer { transition: none; }
  .progress.indeterminate > i { animation: none; }
}
`

const svg = (paths: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`

export const icons = {
  cube: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>'),
  reset: svg('<path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4v4.5h4.5"/>'),
  fullscreen: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  exitFullscreen: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  prev: svg('<path d="M15 5l-7 7 7 7"/>'),
  next: svg('<path d="M9 5l7 7-7 7"/>'),
  flow: svg('<path d="M3 8c3-3 6-3 9 0s6 3 9 0M3 15c3-3 6-3 9 0s6 3 9 0"/>'),
  play: svg('<path d="M8 5v14l11-7z"/>'),
  pause: svg('<path d="M8 5v14M16 5v14"/>'),
  label: svg('<circle cx="6" cy="17" r="1.6"/><path d="M7.2 15.8L12 11h8M14 15h6"/>'),
  section: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5v9" stroke-dasharray="2.5 2.2"/><path d="M12 12l8-4.5"/>'),
}
