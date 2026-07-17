// ─── Micro-game: Hot Potato Match — "TOSS!" ────────────────────────────────
//
// vision-board-minigames §8. Too-hot-to-touch theme. A stick figure's two open
// hands sit at the bottom of the page. A glowing, sizzling charcoal briquette
// lands in one palm — too hot to hold. A ring contracts over the EMPTY hand;
// tap that hand as the ring aligns to lob the stone across before the holding
// hand starts smoking. Toss it back and forth three times to win.
//
// The tension is the holding hand HEATING UP: a smoke meter fills while you
// hold. Nail the toss on the beat and it resets on the other hand. Miss the
// window — let the meter fill — and that hand bursts into a soot cloud.

import type { MicroGame, MicroGameCtx } from '../types'
import { NOTEBOOK, HIGHLIGHT } from '@/use/ink/palette'
import { mulberry32, range, makeRng } from '@/use/ink/rng'
import { squeak, sizzle, penClick } from '@/use/ink/useInkAudio'
import { inkText } from '@/use/ink/strokeFont'
import { type Ring, stepRing, isHot, drawRing } from '../ring'
import type { InkRenderer, Pt } from '@/use/ink/inkRenderer'

const TOSSES_TO_WIN = 3
/** Seconds a hand can hold before it smokes. Sized so the ring aligns TWICE
 *  inside it (see RING_SPEED): the first pass is the beat to hit, and a second
 *  pass gives a recovery chance so one fumbled tap doesn't instantly burn —
 *  only genuine dithering does. */
const HOLD_LIMIT = 2.7
/** Empty-hand ring contraction speed. At 0.82 the hot window opens ~1.0s and
 *  recycles to a second window ~2.24s, both before the 2.7s burn. (makeRing's
 *  default 0.44 aligned at ~1.9s — after the hand had already caught fire.) */
const RING_SPEED = 0.82

class HotPotato implements MicroGame {
  readonly id = 'potato'
  readonly verbKey = 'game.potato.verb'
  readonly hintKey = 'game.potato.hint'
  readonly baseDuration = 6

  private rng: () => number = Math.random
  private s = 1
  private leftX = 0
  private rightX = 0
  private handY = 0
  /** Which hand holds the stone: -1 left, +1 right. */
  private side = -1
  private ring: Ring = { ring: 1, speed: 0.5 }
  /** 0..1 how hot the holding hand is (smoke meter). */
  private heat = 0
  private tosses = 0
  /** Stone flight animation: 0..1, -1 = at rest in a hand. */
  private flight = -1
  private flightFrom = -1
  private burned = false
  private burnedSide = -1
  private burnAt = 0
  private won = false
  /** OUCH! popup timer. */
  private ouchAt = 99

  init(ctx: MicroGameCtx, seed: number): void {
    const { ink } = ctx
    const st = ink.stage
    this.rng = mulberry32(seed)
    this.s = st.w * 0.0016
    this.leftX = st.cx - st.w * 0.26
    this.rightX = st.cx + st.w * 0.26
    this.handY = st.y + st.h * 0.72
    this.side = this.rng() < 0.5 ? -1 : 1
    this.ring = { ring: 1, speed: RING_SPEED }
    this.heat = 0
    this.tosses = 0
    this.flight = -1
    this.burned = false
    this.won = false
    this.ouchAt = 99
  }

  private handX(side: number): number { return side < 0 ? this.leftX : this.rightX }

  update(ctx: MicroGameCtx, dt: number) {
    const { pointer, services } = ctx
    if (this.ouchAt < 90) this.ouchAt += dt
    if (this.burned) { this.burnAt += dt; return undefined }
    if (this.won) return undefined

    // Stone in flight — animate then settle.
    if (this.flight >= 0) {
      this.flight = Math.min(1, this.flight + dt * 5)
      if (this.flight >= 1) this.flight = -1
    } else {
      // Held: the hand heats up and the empty-hand ring contracts.
      this.heat += dt / HOLD_LIMIT
      stepRing(this.ring, dt)
      if (this.heat >= 1) {
        // Held too long — this hand burns.
        this.burned = true
        this.burnedSide = this.side
        this.burnAt = 0
        sizzle()
        services.shake('rip')
        services.impactFrame(2)
        return 'lost'
      }

      if (pointer.pressed) {
        const emptyX = this.handX(-this.side)
        const d = Math.hypot(pointer.x - emptyX, pointer.y - this.handY)
        const hitR = 96 * this.s
        if (d < hitR) {
          if (isHot(this.ring)) {
            // Tossed on the beat.
            this.tosses++
            this.flightFrom = this.side
            this.side = -this.side
            this.flight = 0
            this.heat = 0
            this.ring = { ring: 1, speed: RING_SPEED }
            this.ouchAt = 0
            squeak()
            services.shake('snap')
            if (this.tosses >= TOSSES_TO_WIN) { this.won = true; return 'won' }
          } else {
            penClick()
            services.shake('tick')
          }
        }
      }
    }
    return undefined
  }

  /** Current stone position (interpolated during flight). */
  private stonePos(): Pt {
    const s = this.s
    if (this.flight >= 0) {
      const fromX = this.handX(this.flightFrom)
      const toX = this.handX(-this.flightFrom)
      const f = this.flight
      const x = fromX + (toX - fromX) * f
      // A high arc.
      const y = this.handY - 24 * s - Math.sin(f * Math.PI) * 180 * s
      return { x, y }
    }
    return { x: this.handX(this.side), y: this.handY - 24 * s }
  }

  draw(ctx: MicroGameCtx): void {
    this.drawFigure(ctx)
    this.drawHand(ctx, -1)
    this.drawHand(ctx, 1)
    this.drawStone(ctx)
    // The ring hovers over the empty hand (target).
    if (this.flight < 0) {
      const { ink } = ctx
      drawRing(ink, 'potatoring', this.handX(-this.side), this.handY, 40 * this.s, this.ring, {
        cool: 'cyan', hot: 'yellow', reach: 70 * this.s, width: 6 * this.s
      })
    }
    if (this.ouchAt < 0.5) this.drawOuch(ctx)
    this.drawTally(ctx)
  }

  drawOutcome(ctx: MicroGameCtx, outcome: 'won' | 'lost', since: number): void {
    this.drawFigure(ctx)
    this.drawHand(ctx, -1, outcome === 'lost' && this.burnedSide === -1 ? since : 0)
    this.drawHand(ctx, 1, outcome === 'lost' && this.burnedSide === 1 ? since : 0)
    if (outcome === 'won') this.drawStone(ctx)
    if (outcome === 'won' && this.ouchAt < 0.5) this.drawOuch(ctx)
  }

  /** The stick figure body + arms reaching down to the two hands. */
  private drawFigure(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const st = ink.stage
    const s = this.s
    const hx = st.cx
    const hy = st.y + st.h * 0.24
    const line = { color: NOTEBOOK.ink, width: 5 * s, passes: 2 } as const
    // Head.
    ink.circle('hp-head', hx, hy, 34 * s, line)
    // Nervous eyes + gritted mouth (this is stressful!).
    for (let e = -1; e <= 1; e += 2) ink.fillCircle(hx + e * 11 * s, hy - 4 * s, 5 * s, NOTEBOOK.ink)
    ink.stroke('hp-mouth', [
      { x: hx - 14 * s, y: hy + 16 * s }, { x: hx, y: hy + 10 * s }, { x: hx + 14 * s, y: hy + 16 * s }
    ], { color: NOTEBOOK.ink, width: 3 * s, passes: 1 })
    // Body.
    ink.stroke('hp-body', [{ x: hx, y: hy + 34 * s }, { x: hx, y: st.y + st.h * 0.5 }], line)
    // Arms out to each hand.
    ink.stroke('hp-arm-l', [{ x: hx, y: hy + 60 * s }, { x: this.leftX, y: this.handY - 20 * s }], line)
    ink.stroke('hp-arm-r', [{ x: hx, y: hy + 60 * s }, { x: this.rightX, y: this.handY - 20 * s }], line)
  }

  /** An open palm. `burnSince` > 0 turns it into a soot cloud. */
  private drawHand(ctx: MicroGameCtx, side: number, burnSince = 0): void {
    const { ink } = ctx
    const s = this.s
    const x = this.handX(side)
    const y = this.handY
    const holding = this.flight < 0 && this.side === side

    if (burnSince > 0) {
      // Blackened soot cloud.
      const grow = Math.min(1, burnSince * 3)
      ink.splatter(`soot${side}`, x, y, (30 + grow * 30) * s, '#1a1a1e', 12, 2.6)
      const rng = makeRng(`sootpuff${side}`, ink.boil)
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2
        ink.circle(`sootp${side}${i}`, x + Math.cos(a) * 30 * s, y - grow * 40 * s + Math.sin(a) * 20 * s,
          (14 + grow * 10) * s, { color: '#3a3a40', width: 3 * s, passes: 1, alpha: 0.6 })
      }
      return
    }

    // A cupped hand: palm arc + four fingers.
    ink.stroke(`hand${side}`, [
      { x: x - 38 * s, y: y - 6 * s },
      { x: x - 30 * s, y: y + 24 * s },
      { x: x, y: y + 32 * s },
      { x: x + 30 * s, y: y + 24 * s },
      { x: x + 38 * s, y: y - 6 * s }
    ], { color: NOTEBOOK.ink, width: 5 * s, passes: 2, bleed: true })
    for (let f = -2; f <= 2; f++) {
      ink.stroke(`hand${side}f${f}`, [
        { x: x + f * 16 * s, y: y + 24 * s - Math.abs(f) * 4 * s },
        { x: x + f * 18 * s, y: y - 24 * s - Math.abs(f) * 2 * s }
      ], { color: NOTEBOOK.ink, width: 4.5 * s, passes: 1 })
    }
    // Smoke wisps off the holding hand as it heats up.
    if (holding && this.heat > 0.25) {
      const rng = makeRng(`smoke${side}`, ink.boil)
      const n = Math.floor(this.heat * 4)
      for (let i = 0; i < n; i++) {
        const sx = x + range(rng, -20, 20) * s
        ink.stroke(`smoke${side}${i}`, [
          { x: sx, y: y - 30 * s - i * 20 * s },
          { x: sx + range(rng, -12, 12) * s, y: y - 54 * s - i * 20 * s }
        ], { color: NOTEBOOK.inkSoft, width: 3 * s, passes: 1, alpha: 0.3 * this.heat, rough: 4 })
      }
    }
  }

  /** The glowing charcoal briquette. */
  private drawStone(ctx: MicroGameCtx): void {
    const { ink, t } = ctx
    const s = this.s
    const p = this.stonePos()
    // Neon-orange heat glow.
    const glow = 0.5 + Math.sin(t * 10) * 0.2
    ink.highlightBlob('stoneglow', p.x, p.y, 34 * s, 'orange', 0.5 * glow)
    // The lump — a chunky irregular pentagon.
    const rng = makeRng('stone', 0)
    const pts: Pt[] = []
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2
      const r = 22 * s * range(rng, 0.82, 1.15)
      pts.push({ x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r })
    }
    ink.fill(pts, '#2a2622', 0.95)
    ink.shape('stone', pts, { color: NOTEBOOK.ink, width: 3.4 * s, passes: 2, bleed: true })
    // Glowing embers on it.
    for (let i = 0; i < 3; i++) {
      const a = t * 2 + i * 2
      ink.fillCircle(p.x + Math.cos(a) * 10 * s, p.y + Math.sin(a) * 8 * s, 3.5 * s, '#ff6a1a', glow)
    }
    // Little flame flickers on top.
    const fr = makeRng('stoneflame', ink.boil)
    ink.fill([
      { x: p.x - 8 * s, y: p.y - 18 * s }, { x: p.x + range(fr, -4, 4) * s, y: p.y - 38 * s },
      { x: p.x + 8 * s, y: p.y - 18 * s }
    ], HIGHLIGHT.orange, 0.7)
  }

  private drawOuch(ctx: MicroGameCtx): void {
    const { ink, services } = ctx
    const s = this.s
    // Pops over the hand that just caught it.
    const x = this.handX(this.side)
    const pop = Math.min(1, this.ouchAt / 0.09)
    inkText(ink, 'ouch', services.t('game.potato.ouch'), x, this.handY - 70 * s, 30 * s * pop, {
      align: 'center', baseline: 'middle', color: NOTEBOOK.markerRed, width: 4 * s,
      rotate: 0.14, tilt: 0.1, halo: 0.2,
      alpha: Math.max(0, 1 - Math.max(0, (this.ouchAt - 0.3) / 0.2))
    })
  }

  private drawTally(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    const st = ink.stage
    for (let i = 0; i < TOSSES_TO_WIN; i++) {
      const cx = st.cx + (i - 1) * 44 * s
      const cy = st.y + st.h * 0.08
      const done = i < this.tosses
      ink.circle(`ptally${i}`, cx, cy, 12 * s, {
        color: done ? HIGHLIGHT.orange : NOTEBOOK.inkSoft, width: 3.2 * s, passes: 1, alpha: done ? 1 : 0.6
      })
      if (done) ink.fillCircle(cx, cy, 7 * s, HIGHLIGHT.orange, 0.85)
    }
  }

  debug() {
    return {
      tosses: this.tosses,
      side: this.side,
      emptyX: Math.round(this.handX(-this.side)),
      handY: Math.round(this.handY),
      inFlight: this.flight >= 0,
      hot: this.flight < 0 && isHot(this.ring),
      heat: +this.heat.toFixed(2)
    }
  }
}

export const hotPotato = (): MicroGame => new HotPotato()
