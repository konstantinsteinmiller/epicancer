// ─── The canvas host ───────────────────────────────────────────────────────
//
// Owns the render loop, the two-layer canvas, and the juice that sits on top
// of it. Scenes give it an `update(dt)` and a `draw(ink)`; it decides when to
// call each.
//
// ── Why two layers, and two frame rates ──
// The GDD asks for "12 FPS stepped animation" (§2.2) — the deliberate,
// stylised choppiness of hand-animated cartoons. That is not the same as
// "run the game at 12fps": input still has to feel instant, and the juice
// (screen shake, impact frames) has to be silky or it reads as jank.
//
// So the two rates are split:
//   - `update(dt)` runs every animation frame (~60Hz). Physics, input,
//     timers. The game's SIMULATION is smooth.
//   - `draw(ink)` runs 12 times a second, into an offscreen ink layer. The
//     linework — and the boil — steps.
//   - the blit runs every frame, applying shake + impact frames at full rate.
//
// This buys the exact aesthetic AND makes the renderer ~5× cheaper, because
// the expensive part (hundreds of wobbling bezier passes) happens 12 times a
// second instead of 60. It's the single biggest perf decision in the project.

import { onMounted, onUnmounted, ref, shallowRef, type Ref } from 'vue'
import { InkRenderer } from './inkRenderer'
import { isGamePaused } from '@/use/useGamePause'

/** The boil rate. Locked at 12 per the GDD; exported so the escalation system
 *  can read it rather than re-deriving the magic number. */
export const INK_FPS = 12
const INK_STEP_MS = 1000 / INK_FPS

/** Cap device-pixel-ratio. A 3× DPR phone would otherwise ask us to fill 9×
 *  the pixels for a look that is, by design, rough and low-fi. 2 is
 *  indistinguishable here and keeps mid-range Androids at 60fps. */
const MAX_DPR = 2

/**
 * The widest the notebook page is ever allowed to get, as width ÷ height.
 *
 * The game is a portrait notebook, and stretching it to a wide desktop
 * viewport wrecks the "college ruled book on a desk" feel — the paper goes
 * landscape and the ruled lines run for miles. So the page is capped to this
 * portrait aspect and CENTRED, with the surrounding viewport left as dark desk
 * (letterbox bars). A viewport NARROWER than this (every phone) is under the
 * cap and fills fully, so mobile is unaffected.
 *
 * 0.72 ≈ a composition book (7.5"×9.75"). It's also ≥ 1/1.45, which is the
 * `InkRenderer.stage` clamp — so the play area exactly fills the capped page
 * instead of leaving empty paper margins.
 */
const MAX_PAGE_ASPECT = 0.72

export interface InkCanvasHooks {
  /** Simulation tick. `dt` is seconds, clamped so a backgrounded tab can't
   *  deliver a 30-second dt and explode the physics. */
  update?: (dt: number, t: number) => void
  /** Draw the ink layer. Called at 12fps. */
  draw: (ink: InkRenderer) => void
}

export interface ShakeSpec {
  /** Peak displacement in CSS pixels. */
  force: number
  /** Seconds. */
  duration: number
  /** Hz — how fast it rattles. Low = a heavy structural thud (the router
   *  smash), high = a sharp snap (the mosquito slap). GDD §5. */
  freq: number
}

export const SHAKE_PRESETS = {
  /** Router smashing: low-frequency, heavy structural thud. */
  thud: { force: 16, duration: 0.42, freq: 14 },
  /** Mosquito slap: high-frequency, sudden snapping jar. */
  snap: { force: 11, duration: 0.2, freq: 42 },
  /** Page rip on a loss. */
  rip: { force: 20, duration: 0.5, freq: 20 },
  /** Boss banner slam. */
  slam: { force: 26, duration: 0.6, freq: 11 },
  /** A light tick — briefing thump, UI press. */
  tick: { force: 5, duration: 0.16, freq: 30 }
} as const satisfies Record<string, ShakeSpec>

export type ShakePreset = keyof typeof SHAKE_PRESETS

export const useInkCanvas = (hooks: InkCanvasHooks) => {
  const canvasRef = ref<HTMLCanvasElement | null>(null)
  const ink = shallowRef<InkRenderer | null>(null)
  /** Live frame budget, for the debug perf meter. */
  const lastDrawMs = ref(0)

  let ctx: CanvasRenderingContext2D | null = null
  let layer: HTMLCanvasElement | null = null
  let layerCtx: CanvasRenderingContext2D | null = null
  let raf = 0
  let running = false

  let cssW = 0
  let cssH = 0
  let dpr = 1

  let startTs = 0
  let lastTs = 0
  /** Scene time of the most recent simulated frame. A repaint forced by a
   *  resize-while-paused reuses it, so the boil and any time-driven visuals
   *  land exactly where the frozen frame left them. */
  let lastFrameT = 0
  let inkAccum = 0
  let boilFrame = 0
  let layerDirty = true

  // ── Juice state ─────────────────────────────────────────────────────────
  let shakeUntil = 0
  let shakeForce = 0
  let shakeFreq = 20
  let shakeStart = 0
  let flashFrames = 0

  /**
   * Kick a screen shake. Overlapping shakes take the STRONGER one rather than
   * summing — two impacts in the same frame shouldn't fling the camera off
   * screen, they should feel like one bigger hit.
   */
  const shake = (preset: ShakePreset | ShakeSpec, mul = 1): void => {
    const spec = typeof preset === 'string' ? SHAKE_PRESETS[preset] : preset
    const now = performance.now()
    const force = spec.force * mul
    const remaining = Math.max(0, shakeUntil - now)
    if (force >= shakeForce || remaining < 60) {
      shakeForce = force
      shakeFreq = spec.freq
      shakeStart = now
      shakeUntil = now + spec.duration * 1000
    }
  }

  /**
   * Impact frames: invert the whole screen for N frames (GDD §5 asks for 2).
   * Done at blit time with a 'difference' composite against white, which is a
   * single full-screen op — much cheaper than a CSS/canvas `filter: invert()`
   * and it can't be defeated by the compositor.
   */
  const impactFrame = (frames = 2): void => {
    flashFrames = Math.max(flashFrames, frames)
  }

  /** Force a redraw of the ink layer before the next blit. Used when a scene
   *  changes something visible while the sim is paused. */
  const invalidate = (): void => { layerDirty = true }

  /** The full viewport slot to letterbox the page inside. Normally the canvas's
   *  parent, but an explicit `[data-ink-host]` ancestor wins — the canvas may be
   *  wrapped (e.g. so an overlay can dock to the page corner), and that wrapper
   *  shrink-wraps the canvas, which would feed back on our own resize. */
  const hostEl = (cv: HTMLCanvasElement): HTMLElement | null =>
    (cv.closest('[data-ink-host]') as HTMLElement | null) ?? cv.parentElement

  const resize = (): void => {
    const cv = canvasRef.value
    const parent = cv && hostEl(cv)
    if (!cv || !parent) return
    // Measure the host slot, then letterbox the page inside it. We size the
    // canvas ELEMENT to the page rect and let the host centre it — so this must
    // read the host, not the canvas, or it would feed back on its own resize.
    const pr = parent.getBoundingClientRect()
    const availW = Math.max(1, Math.round(pr.width))
    const availH = Math.max(1, Math.round(pr.height))

    // Cap the page's width to MAX_PAGE_ASPECT of its height (portrait). A wide
    // viewport pillarboxes; a portrait one fills.
    let nextW = availW
    let nextH = availH
    if (availW / availH > MAX_PAGE_ASPECT) {
      nextH = availH
      nextW = Math.round(availH * MAX_PAGE_ASPECT)
    }

    const nextDpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
    if (nextW === cssW && nextH === cssH && nextDpr === dpr) return

    cssW = nextW
    cssH = nextH
    dpr = nextDpr

    // The canvas element is the notebook; its CSS px size is the page rect.
    // The parent (flex-centred, dark background) supplies the letterbox bars.
    cv.style.width = `${cssW}px`
    cv.style.height = `${cssH}px`
    cv.width = Math.round(cssW * dpr)
    cv.height = Math.round(cssH * dpr)

    if (!layer) layer = document.createElement('canvas')
    layer.width = cv.width
    layer.height = cv.height
    layerCtx = layer.getContext('2d')

    const r = ink.value
    if (r && layerCtx) {
      // Page space: 1000 units wide, height follows the aspect. This is what
      // makes one layout work from a 320×658 phone to a fullscreen desktop
      // without a single hardcoded pixel.
      r.scale = (cssW * dpr) / r.pw
      r.ph = (cssH * dpr) / r.scale
      r.ctx = layerCtx
    }
    layerDirty = true

    // Assigning `canvas.width` wipes the canvas to transparent. Normally the
    // next frame repaints it — but if we're PAUSED (an ad is up, the tab is
    // hidden, a modal is open) there is no next frame, and the game would sit
    // there as a blank rectangle until the player dismissed whatever paused
    // it. A rotate-during-ad or a tab-restore-with-new-size hits this exactly.
    // So repaint once, synchronously, off the sim clock.
    if (isGamePaused.value) renderOnce()
  }

  /** Redraw the ink layer and present it, without advancing the simulation.
   *  Used to recover from a resize that happened while paused. */
  const renderOnce = (): void => {
    if (!ink.value || !layerCtx || !ctx) return
    drawInkLayer(lastFrameT)
    layerDirty = false
    blit(performance.now())
  }

  const drawInkLayer = (t: number): void => {
    const r = ink.value
    if (!r || !layerCtx) return
    const t0 = performance.now()
    layerCtx.setTransform(1, 0, 0, 1, 0, 0)
    layerCtx.clearRect(0, 0, layerCtx.canvas.width, layerCtx.canvas.height)
    layerCtx.scale(r.scale, r.scale)
    r.boil = boilFrame
    r.t = t
    hooks.draw(r)
    lastDrawMs.value = performance.now() - t0
  }

  const blit = (now: number): void => {
    if (!ctx || !layer) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)

    let ox = 0
    let oy = 0
    if (now < shakeUntil && shakeForce > 0) {
      const elapsed = (now - shakeStart) / 1000
      const total = (shakeUntil - shakeStart) / 1000
      // Decay to zero so the camera settles instead of snapping back.
      const decay = Math.max(0, 1 - elapsed / total)
      const amp = shakeForce * decay * decay * dpr
      // Two out-of-phase sines rather than random noise: random jitters at
      // 60fps read as static, whereas a rattle reads as an impact.
      ox = Math.sin(elapsed * shakeFreq * Math.PI * 2) * amp
      oy = Math.cos(elapsed * shakeFreq * Math.PI * 2 * 0.83) * amp * 0.7
    }

    ctx.drawImage(layer, ox, oy)

    if (flashFrames > 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'difference'
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
      ctx.restore()
      flashFrames--
    }
  }

  const frame = (now: number): void => {
    if (!running) return
    raf = requestAnimationFrame(frame)

    if (startTs === 0) startTs = now
    // Clamp dt: a backgrounded tab resumes with a huge delta, which would
    // tunnel the cord physics straight through the page and fire every timer
    // at once.
    const dt = Math.min(0.05, (now - lastTs) / 1000) || 0
    lastTs = now
    const t = (now - startTs) / 1000
    lastFrameT = t

    // The pause gate covers ads, hidden tabs, portal pause callbacks and
    // in-game modals (see useGamePause). Freeze the sim, keep the last frame
    // on screen — an ad must never have gameplay ticking underneath it.
    if (isGamePaused.value) return

    hooks.update?.(dt, t)

    inkAccum += dt * 1000
    if (inkAccum >= INK_STEP_MS || layerDirty) {
      // Drop accumulated time rather than catching up: after a stall we want
      // the NEXT frame, not a burst of stale ones.
      inkAccum = inkAccum % INK_STEP_MS
      boilFrame = Math.floor(t * INK_FPS) % 3
      drawInkLayer(t)
      layerDirty = false
    }

    blit(now)
  }

  const start = (): void => {
    if (running) return
    running = true
    startTs = 0
    lastTs = performance.now()
    raf = requestAnimationFrame(frame)
  }

  const stop = (): void => {
    running = false
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  let ro: ResizeObserver | null = null

  onMounted(() => {
    const cv = canvasRef.value
    if (!cv) return
    // `alpha: false` lets the compositor skip per-pixel blending on the
    // presented canvas. The page is opaque anyway.
    ctx = cv.getContext('2d', { alpha: false })
    if (!ctx) return
    ink.value = new InkRenderer(ctx)
    resize()
    // Observe the HOST slot, not the canvas — `resize()` sets the canvas's own
    // CSS size, so observing the canvas would loop. The host tracks the viewport
    // (incl. safe-area / URL-bar changes on mobile, which don't always emit a
    // window resize event).
    ro = new ResizeObserver(() => resize())
    const host = hostEl(cv)
    if (host) ro.observe(host)
    start()
  })

  onUnmounted(() => {
    stop()
    ro?.disconnect()
    ro = null
  })

  return {
    canvasRef,
    ink,
    shake,
    impactFrame,
    invalidate,
    start,
    stop,
    resize,
    lastDrawMs
  }
}

export type InkCanvas = ReturnType<typeof useInkCanvas>
