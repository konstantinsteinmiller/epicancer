// ─── The notebook HUD ──────────────────────────────────────────────────────
//
// Score, hearts and the clock, drawn INTO the page rather than laid over it in
// DOM. A crisp CSS heart floating above a boiling pen drawing would break the
// illusion instantly — everything the player sees must have been scribbled by
// the same bored teenager.
//
// The clock is a burning matchstick "rapidly turning to ash" (vision-board
// panel 3) rather than a bar or a number: it's readable at a glance, it's
// thematically part of the desk, and its flame gives us somewhere to put
// escalating panic.

import type { InkRenderer, Pt } from '@/use/ink/inkRenderer'
import { NOTEBOOK, HIGHLIGHT } from '@/use/ink/palette'
import { makeRng, range } from '@/use/ink/rng'
import { inkText } from '@/use/ink/strokeFont'

/** Left edge of the HUD column, in page units. Sits right of the spiral
 *  binding and the red margin rule so nothing collides with the page furniture. */
const HUD_X_UNITS = 128

/**
 * The burning match. `left` is 0..1 of time remaining.
 *
 * Drawn top-right, inset from the page edge — `safeTop` lets the scene push it
 * clear of a notch (the canvas fills the viewport, so the safe-area inset has
 * to reach the ink layer as a number).
 */
export const drawMatchTimer = (ink: InkRenderer, left: number, safeTop = 0): void => {
  const clamped = Math.max(0, Math.min(1, left))
  const x = ink.pw - ink.u(56)
  const top = safeTop + ink.u(40)
  const len = ink.u(220)
  const burntY = top + len * (1 - clamped)

  // The match is lit at the TOP and the flame eats downward toward the fingers,
  // so the burnt section is always ABOVE the flame and the unburnt stick below
  // it. (Putting a match head on the far end would read as upside-down: you'd
  // be looking at a match burning toward its own head.)
  //
  // The spent stick stays on the page as charred grey, so the player reads
  // "how much I already used" as well as "what's left".
  if (clamped < 1) {
    ink.line('match-ash', x, top, x, burntY, {
      color: NOTEBOOK.pencil, width: ink.u(9), passes: 1, alpha: 0.4, rough: 2.2
    })
  }
  // The unburnt stick.
  ink.line('match-stick', x, burntY, x, top + len, {
    color: NOTEBOOK.ink, width: ink.u(9), passes: 2, bleed: true
  })

  if (clamped <= 0) return

  // The flame at the burn line. It grows and reddens as time runs out — the
  // panic signal, visible even when the player's eyes are on the middle of the
  // page.
  const urgency = 1 - clamped
  const rng = makeRng('flame', ink.boil)
  const h = ink.u(20) + urgency * ink.u(26)
  const w = ink.u(11) + urgency * ink.u(7)
  const flame: Pt[] = [
    { x: x - w * 0.5, y: burntY },
    { x: x - w * range(rng, 0.3, 0.7), y: burntY - h * 0.45 },
    { x: x + range(rng, -w * 0.3, w * 0.3), y: burntY - h },
    { x: x + w * range(rng, 0.3, 0.7), y: burntY - h * 0.45 },
    { x: x + w * 0.5, y: burntY }
  ]
  ink.fill(flame, urgency > 0.6 ? HIGHLIGHT.orange : HIGHLIGHT.yellow, 0.85)
  ink.stroke('flame', flame, {
    color: NOTEBOOK.markerRed, width: ink.u(2.4), passes: 1, close: true, rough: 2
  })

  // Smoke wisps — cheap, and they sell the burn.
  for (let i = 0; i < 2; i++) {
    const sy = burntY - h - ink.u(10) - i * ink.u(18)
    ink.stroke(`smoke${i}`, [
      { x: x + range(rng, -6, 6), y: sy },
      { x: x + range(rng, -14, 14), y: sy - ink.u(16) }
    ], { color: NOTEBOOK.pencil, width: ink.u(2), passes: 1, alpha: 0.3 - i * 0.1, rough: 3 })
  }
}

/**
 * The heart track. Lost hearts stay on the page as crossed-out scribbles —
 * an empty slot says "you have 2"; a crossed-out heart says "you LOST one",
 * which is the feeling we want to keep in front of the player.
 */
export const drawHearts = (ink: InkRenderer, hearts: number, max: number, safeTop = 0): void => {
  const HUD_X = ink.u(HUD_X_UNITS)
  const size = ink.u(26)
  const gap = ink.u(64)
  const y = safeTop + ink.u(52)
  // Start clear of the spiral binding (x≈30) and the red margin rule (x≈86) —
  // the HUD is scribbled in the page's own left margin area, and overlapping
  // the binding rings made the score unreadable.
  for (let i = 0; i < max; i++) {
    const x = HUD_X + i * gap
    const alive = i < hearts
    drawHeart(ink, `heart${i}`, x, y, size, alive)
    if (!alive) {
      // Scribbled out.
      ink.line(`heartx${i}a`, x - size, y - size, x + size, y + size, {
        color: NOTEBOOK.markerRed, width: ink.u(4), passes: 2, rough: 2.6
      })
      ink.line(`heartx${i}b`, x + size, y - size, x - size, y + size, {
        color: NOTEBOOK.markerRed, width: ink.u(4), passes: 2, rough: 2.6
      })
    }
  }
}

const drawHeart = (ink: InkRenderer, id: string, cx: number, cy: number, r: number, filled: boolean): void => {
  // A heart as a parametric curve, sampled coarsely — the pen wobble does the
  // rest of the work.
  const pts: Pt[] = []
  const steps = 18
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const x = 16 * Math.pow(Math.sin(t), 3)
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))
    pts.push({ x: cx + (x / 16) * r, y: cy + (y / 16) * r })
  }
  if (filled) ink.fill(pts, NOTEBOOK.markerRed, 0.85)
  ink.stroke(id, pts, {
    color: filled ? NOTEBOOK.markerRed : NOTEBOOK.pencil,
    width: ink.u(3),
    passes: 2,
    close: true,
    alpha: filled ? 1 : 0.5
  })
}

/** The running score — ideas survived — tallied under the hearts. Sits on the
 *  LEFT with the hearts because the right column belongs to the match, and the
 *  two would collide as the match burns down. Small: it's a record, not the
 *  point. */
export const drawScore = (ink: InkRenderer, score: number, safeTop = 0): void => {
  const HUD_X = ink.u(HUD_X_UNITS)
  inkText(ink, 'score', String(score), HUD_X, safeTop + ink.u(132), ink.u(40), {
    align: 'center',
    color: NOTEBOOK.inkSoft,
    width: ink.u(4),
    tilt: 0.06
  })
}
