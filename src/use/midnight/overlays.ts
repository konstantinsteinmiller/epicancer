// ─── Briefing, judgment and transitions ────────────────────────────────────
//
// The connective tissue of the loop (GDD §3): the verb that slams in, the
// stamp that judges you, and the page that flips. These are drawn into the ink
// layer like everything else.

import type { InkRenderer, Pt } from '@/use/ink/inkRenderer'
import { NOTEBOOK } from '@/use/ink/palette'
import { makeRng, range } from '@/use/ink/rng'
import { inkText, measureInkText } from '@/use/ink/strokeFont'

/** Ease-out-back — overshoots then settles. The verb doesn't arrive, it
 *  LANDS. */
const backOut = (t: number): number => {
  const c = 1.9
  const p = t - 1
  return 1 + p * p * ((c + 1) * p + c)
}

/**
 * The briefing: "a punchy, one-word verb instruction flashes in huge, raw
 * marker ink across the centre of the screen" (GDD §3.1).
 *
 * `p` is 0..1 through the briefing phase. The word scales down from oversized
 * and overshoots, which is what makes the accompanying bass thump land as an
 * impact rather than a beep.
 */
export const drawBriefing = (
  ink: InkRenderer, verb: string, hint: string | null, p: number
): void => {
  const t = Math.max(0, Math.min(1, p))
  // Punch in fast (first 30%), hold, then snap away at the very end.
  const inP = Math.min(1, t / 0.3)
  const scale = 1.35 - 0.35 * backOut(inP)
  // Fade only at the tail — the word must be at full strength while it's
  // being read.
  const alpha = t > 0.86 ? 1 - (t - 0.86) / 0.14 : 1

  // Fit the verb to the page: long words ("BALANCE!") must not run off a
  // 320px-wide phone. Measure, then shrink to fit the usable width.
  const maxW = ink.pw * 0.86
  let size = ink.u(120)
  const natural = measureInkText(verb, size)
  if (natural > maxW) size *= maxW / natural

  const cx = ink.cx
  const cy = ink.ph * 0.44

  ink.ctx.save()
  ink.ctx.globalAlpha = alpha
  ink.transformed(cx, cy, 0, scale, () => {
    inkText(ink, 'verb', verb, 0, 0, size, {
      align: 'center',
      baseline: 'middle',
      color: NOTEBOOK.markerRed,
      width: size * 0.14,
      bleed: true,
      tilt: 0.07,
      scatter: 0.04,
      passes: 2
    })
  })

  // A hint line for a player's first meetings with this game. The GDD's loop
  // gives one word — perfect once you know the game, opaque the first time.
  // This is the onboarding valve, so it's built to be READ: dark ink for
  // contrast, a white halo so it lifts off whatever game art is behind it, and
  // it holds at full strength almost to the end of the (deliberately longer)
  // hinted briefing rather than fading early like the verb.
  if (hint) {
    // Fit the hint to the page too — a full sentence in a locale like German
    // can be long, and it must not run off a 320px phone.
    let hintSize = ink.u(38)
    const hintMaxW = ink.pw * 0.9
    const hintNatural = measureInkText(hint, hintSize)
    if (hintNatural > hintMaxW) hintSize *= hintMaxW / hintNatural
    // Hold readable until the very tail, then fade.
    const hintAlpha = t > 0.9 ? 1 - (t - 0.9) / 0.1 : 1
    inkText(ink, 'hint', hint, cx, cy + ink.u(104), hintSize, {
      align: 'center',
      baseline: 'middle',
      color: NOTEBOOK.ink,
      width: hintSize * 0.09,
      tilt: 0.02,
      halo: 0.2,
      alpha: hintAlpha
    })
  }
  ink.ctx.restore()
}

/**
 * The judgment stamp (GDD §3.3). A win stamps a thick crimson "OK"; a loss
 * scribbles the page out in heavy black ink.
 *
 * `p` is 0..1 through the judgment phase.
 */
export const drawJudgment = (ink: InkRenderer, outcome: 'won' | 'lost', p: number): void => {
  const t = Math.max(0, Math.min(1, p))
  const cx = ink.cx
  const cy = ink.ph * 0.5

  if (outcome === 'won') {
    // The stamp slams down: overshoot from big to settled, with a hard tilt
    // so it reads as pressed by a hand, not composited.
    const inP = Math.min(1, t / 0.22)
    const scale = 2.2 - 1.2 * backOut(inP)
    const rot = -0.16
    ink.transformed(cx, cy, rot, Math.max(0.01, scale), () => {
      inkText(ink, 'ok', 'OK', 0, 0, ink.u(130), {
        align: 'center',
        baseline: 'middle',
        color: NOTEBOOK.markerRed,
        width: ink.u(20),
        passes: 2,
        bleed: true,
        tilt: 0.05
      })
      // The stamp's ring.
      ink.ellipse('okring', 0, 0, ink.u(160), ink.u(96), 0, {
        color: NOTEBOOK.markerRed, width: ink.u(9), passes: 2, rough: 4
      })
    })
  } else {
    // "Failure triggers a paper-ripping sound, crossing out the page in heavy
    // black ink" (GDD §3.3). The scribble draws ON over the first third —
    // the player watches their page get destroyed.
    const rng = makeRng('scribble', 0)
    const strokes = 7
    const drawn = Math.min(1, t / 0.34)
    for (let i = 0; i < strokes; i++) {
      const f = (i + 1) / strokes
      if (drawn < f - 1 / strokes) continue
      const y = ink.ph * range(rng, 0.22, 0.78)
      const y2 = y + range(rng, -ink.u(90), ink.u(90))
      const x0 = ink.pw * range(rng, 0.02, 0.16)
      const x1 = ink.pw * range(rng, 0.84, 0.98)
      // Each stroke wipes on left-to-right within its slice of the timeline.
      const local = Math.max(0, Math.min(1, (drawn - (f - 1 / strokes)) * strokes))
      const pts: Pt[] = [
        { x: x0, y },
        { x: x0 + (x1 - x0) * local, y: y + (y2 - y) * local }
      ]
      ink.stroke(`scrib${i}`, pts, {
        color: NOTEBOOK.ink, width: ink.u(13), passes: 2, rough: 7, bleed: true
      })
    }
  }
}

/**
 * The boss banner: "a BOSS STAGE banner slams down" (vision-board panel 7).
 * `p` is 0..1 through the banner phase.
 */
export const drawBossBanner = (ink: InkRenderer, label: string, p: number): void => {
  const t = Math.max(0, Math.min(1, p))
  // Slams in from above, overshoots, then holds; exits upward at the end.
  const inP = Math.min(1, t / 0.28)
  const outP = t > 0.8 ? (t - 0.8) / 0.2 : 0
  const y = ink.ph * 0.42 - (1 - backOut(inP)) * ink.ph * 0.6 - outP * ink.ph * 0.7

  const h = ink.u(150)
  ink.ctx.save()
  // The banner card.
  ink.fill(
    [
      { x: -ink.u(20), y: y - h / 2 },
      { x: ink.pw + ink.u(20), y: y - h / 2 - ink.u(10) },
      { x: ink.pw + ink.u(20), y: y + h / 2 + ink.u(6) },
      { x: -ink.u(20), y: y + h / 2 }
    ],
    NOTEBOOK.ink,
    0.92
  )
  inkText(ink, 'boss', label, ink.cx, y, ink.u(70), {
    align: 'center',
    baseline: 'middle',
    color: NOTEBOOK.paper,
    width: ink.u(9),
    tilt: 0.08,
    scatter: 0.05
  })
  ink.ctx.restore()
}

/**
 * The page flip (GDD §5, "Paper Physics"): the next page doesn't cut in, it's
 * "aggressively flipped by a hand".
 *
 * A real vertex-warped mesh needs WebGL; this is canvas 2D, so the warp is
 * faked by drawing the outgoing page as a stack of horizontal slices, each
 * sheared and scaled by a travelling wave. At 12fps and full-page width the
 * difference is invisible — and it costs one drawImage per slice instead of a
 * shader pipeline.
 *
 * `snapshot` must be a COPY of the outgoing page, not the live canvas — we
 * draw onto `ink.ctx`, and a canvas cannot safely be its own source here.
 * The caller is expected to have already drawn the incoming (blank) page;
 * this only paints the departing sheet over it.
 *
 * Returns true while the flip is still covering the page.
 */
export const drawPageFlip = (
  ink: InkRenderer, snapshot: HTMLCanvasElement, p: number
): boolean => {
  const t = Math.max(0, Math.min(1, p))
  if (t >= 1) return false
  const { ctx } = ink
  const layer = snapshot
  const w = layer.width
  const h = layer.height

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  const SLICES = 26
  const sliceH = h / SLICES
  for (let i = 0; i < SLICES; i++) {
    const f = i / SLICES
    // A wave that travels down the page, so the sheet peels rather than
    // sliding as a rigid block.
    const phase = Math.max(0, Math.min(1, t * 1.5 - f * 0.5))
    const ease = phase * phase
    const x = -ease * w * 1.15
    // Bow the middle of the sheet toward the viewer.
    const bow = Math.sin(f * Math.PI) * ease * h * 0.05
    const squash = 1 - ease * 0.25
    ctx.save()
    ctx.translate(x, i * sliceH + bow)
    ctx.scale(1, squash)
    ctx.drawImage(layer, 0, i * sliceH, w, sliceH, 0, 0, w, sliceH + 1)
    ctx.restore()
  }
  ctx.restore()
  return true
}
