// ─── Shared contracting-ring timing mechanic ───────────────────────────────
//
// Five of the micro-games (mirage, thermometer, hot-potato, fan, shadow-jump)
// are the same core interaction the mosquito game pioneered: a highlighter ring
// contracts toward a target, and a tap only counts in the brief window where
// the ring has collapsed onto it. This module is that mechanic, once — the
// state (`Ring`), the update, and the draw — so the five games share identical
// timing FEEL and only differ in their art and what a hit does.
//
// The existing mosquito / cat games predate this and keep their own copies; not
// worth the regression risk to retrofit them. New ring games use this.
//
// Timing values match the mosquito's, which QA is happy with: a generous
// window, and a ring that RECYCLES past the collapse rather than vanishing —
// so a mistimed tap just means "wait for the next pass", never a dead target
// the player can't clear on a short clock.

import type { InkRenderer } from '@/use/ink/inkRenderer'
import { HIGHLIGHT, type HighlightColor } from '@/use/ink/palette'
import { makeRng, range } from '@/use/ink/rng'

/** How close to the collapse a tap must land, in ring-progress units. */
export const HIT_WINDOW = 0.16

export interface Ring {
  /** Progress: 1 = wide open, 0 = collapsed onto the target, negatives = just
   *  past (still inside the window until -HIT_WINDOW). */
  ring: number
  /** Rings per second. */
  speed: number
}

/** True when a tap on this ring would count. */
export const isHot = (r: Ring): boolean => Math.abs(r.ring) <= HIT_WINDOW

/**
 * Advance a ring and recycle it once it has fully passed the window, so a
 * target the player keeps missing always gets another pass. Returns the ring
 * for chaining.
 */
export const stepRing = (r: Ring, dt: number): Ring => {
  r.ring -= r.speed * dt
  if (r.ring <= -HIT_WINDOW) r.ring = 1
  return r
}

/** A fresh ring with a staggered start so several on screen never collapse in
 *  lockstep (which would make them untappable with one finger). */
export const makeRing = (index: number, rng: () => number): Ring => ({
  ring: 1,
  speed: 0.44 + index * 0.1 + range(rng, -0.03, 0.03)
})

export interface DrawRingOpts {
  /** Ring colour while still contracting. */
  cool?: HighlightColor
  /** Ring colour in the hit window. */
  hot?: HighlightColor
  /** Widest the ring reaches beyond the target, in page units. */
  reach?: number
  /** Base line width in page units (the hot ring is drawn heavier). */
  width?: number
  /** Draw the soft hot-flare blob when aligned. */
  flare?: boolean
}

/**
 * Draw a contracting ring around a target at (x, y) with inner radius
 * `innerR`. The ring is a highlighter circle — the game's "touch me" language —
 * that turns hot-coloured and heavies up inside the window, which is the tell
 * the player reacts to.
 */
export const drawRing = (
  ink: InkRenderer, id: string, x: number, y: number, innerR: number, r: Ring, opts: DrawRingOpts = {}
): void => {
  const s = ink.u(1)
  const hot = isHot(r)
  const reach = opts.reach ?? ink.u(92)
  const w = opts.width ?? ink.u(5)
  const ringR = innerR + Math.max(0, r.ring) * reach
  ink.circle(id, x, y, ringR, {
    color: hot ? HIGHLIGHT[opts.hot ?? 'pink'] : HIGHLIGHT[opts.cool ?? 'cyan'],
    width: hot ? w * 1.8 : w,
    passes: hot ? 2 : 1,
    rough: 2.4,
    alpha: hot ? 1 : 0.75
  })
  if (hot && (opts.flare ?? true)) {
    ink.highlightBlob(`${id}-flare`, x, y, innerR * 2.2, opts.hot ?? 'pink', 0.4)
  }
}

/**
 * A shower of sparkles bursting from a point — the shared "you nailed it"
 * flourish (mirage BOOP sparkles, ice CRACKLE shards, etc.). `age` is seconds
 * since the burst; it grows and fades over ~0.5s.
 */
export const drawSparkleBurst = (
  ink: InkRenderer, id: string, x: number, y: number, age: number, color: HighlightColor, count = 9
): void => {
  if (age > 0.5) return
  const grow = Math.min(1, age / 0.1)
  const fade = Math.max(0, 1 - (age - 0.1) / 0.4)
  const rng = makeRng(id, ink.boil)
  const s = ink.u(1)
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + range(rng, -0.2, 0.2)
    const d = (20 + grow * 70) * s * range(rng, 0.7, 1.2)
    const sx = x + Math.cos(a) * d
    const sy = y + Math.sin(a) * d
    // A four-point sparkle star.
    const r = 8 * s * fade * range(rng, 0.7, 1.3)
    ink.stroke(`${id}s${i}h`, [{ x: sx - r, y: sy }, { x: sx + r, y: sy }], {
      color: HIGHLIGHT[color], width: 3 * s, passes: 1, alpha: fade
    })
    ink.stroke(`${id}s${i}v`, [{ x: sx, y: sy - r }, { x: sx, y: sy + r }], {
      color: HIGHLIGHT[color], width: 3 * s, passes: 1, alpha: fade
    })
  }
}
