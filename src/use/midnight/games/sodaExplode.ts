// ─── Micro-game: Soda Explode — "TAP!" ─────────────────────────────────────
//
// vision-board-minigames §5. A crumpled, shaken soda can sits centre-page, its
// tab vibrating, ringed by fizzing neon-pink warning bubbles. A neon-yellow
// target zone on the side of the can invites taps: tap it a few times to settle
// the pressure, THEN click the tab to open it. Success = PSSSHHH + a pour stream;
// too slow = the can erupts and floods the notebook in pink foam.
//
// ── Two-stage input ──
// This is the only micro-game with a mode switch: first you're tapping the
// SIDE (settle), then you click the TAB (open). The target zone highlight moves
// from the side to the tab when the fifth tap lands, so the player is always
// told where to aim without reading anything. Timeout while still fizzing is
// the loss — the pressure won.

import type { MicroGame, MicroGameCtx } from '../types'
import { NOTEBOOK, HIGHLIGHT } from '@/use/ink/palette'
import { mulberry32, range, makeRng } from '@/use/ink/rng'
import { clink, pssh, penClick } from '@/use/ink/useInkAudio'
import { inkText } from '@/use/ink/strokeFont'
import type { Pt } from '@/use/ink/inkRenderer'

// Soda is the ONLY two-stage micro-game: mash the side to settle, THEN find and
// tap the tab. That second stage costs real reaction time no single-tap game
// pays, so the settle can't be as long — otherwise the escalation-shortened
// clock (down to ~baseDuration/MAX_SPEED) runs out mid-transition and a correct
// tab tap still "loses" to the eruption timeout. Three taps keeps the mash
// feel while leaving room to reach the tab even at full escalation.
const TAPS_NEEDED = 3

interface Bubble {
  a: number
  r: number
  rad: number
  pop: number
}

class SodaExplode implements MicroGame {
  readonly id = 'soda'
  readonly verbKey = 'game.soda.verb'
  readonly hintKey = 'game.soda.hint'
  // A touch longer than the single-action games (which sit at ~5s) because of
  // the two-stage settle-then-open interaction above.
  readonly baseDuration = 6

  private rng: () => number = Math.random
  private s = 1
  private cx = 0
  private cy = 0
  private cw = 0
  private ch = 0
  private taps = 0
  private opened = false
  private won = false
  private erupted = false
  private tapAt = -1
  private openAt = -1
  private bubbles: Bubble[] = []

  init(ctx: MicroGameCtx, seed: number): void {
    const { ink } = ctx
    const st = ink.stage
    this.rng = mulberry32(seed)
    this.s = st.w * 0.0016
    this.cw = st.w * 0.24
    this.ch = st.h * 0.42
    this.cx = st.cx
    this.cy = st.cy + st.h * 0.02
    this.taps = 0
    this.opened = false
    this.won = false
    this.erupted = false
    this.tapAt = -1
    this.openAt = -1
    // A ring of warning bubbles.
    this.bubbles = []
    for (let i = 0; i < 14; i++) {
      this.bubbles.push({
        a: range(this.rng, 0, Math.PI * 2),
        r: range(this.rng, 0.55, 1),
        rad: range(this.rng, 8, 18),
        pop: 0
      })
    }
  }

  private get settled(): boolean { return this.taps >= TAPS_NEEDED }

  /** Dev-only view (GameScene's `__midnight.state().detail`): where to tap. */
  debug() {
    const z = this.sideZone(); const tab = this.tabPos()
    return {
      taps: this.taps, settled: this.settled, opened: this.opened,
      side: { x: Math.round(z.x + z.w / 2), y: Math.round(z.y + z.h / 2) },
      tab: { x: Math.round(tab.x), y: Math.round(tab.y) }
    }
  }
  /** The side target zone rect, in page units. */
  private sideZone() {
    return { x: this.cx - this.cw * 0.5, y: this.cy - this.ch * 0.1, w: this.cw, h: this.ch * 0.4 }
  }
  private tabPos(): Pt { return { x: this.cx - this.cw * 0.18, y: this.cy - this.ch * 0.52 } }

  update(ctx: MicroGameCtx, dt: number) {
    const { pointer, services } = ctx
    if (this.tapAt >= 0) this.tapAt += dt
    if (this.openAt >= 0) this.openAt += dt
    if (this.won) return undefined

    if (pointer.pressed) {
      if (!this.settled) {
        // Tapping the side settles pressure. Generous hit box — this is a mash.
        const z = this.sideZone()
        const inZone = pointer.x > z.x - 30 * this.s && pointer.x < z.x + z.w + 30 * this.s
          && pointer.y > z.y - 20 * this.s && pointer.y < z.y + z.h + 20 * this.s
        if (inZone) {
          this.taps++
          this.tapAt = 0
          clink(this.taps)
          services.shake('tick', 0.7)
          // Shrink the danger: pop a bubble per tap.
          const live = this.bubbles.filter((b) => b.pop === 0)
          for (let k = 0; k < Math.ceil(live.length / (TAPS_NEEDED - this.taps + 1)); k++) {
            if (live[k]) live[k]!.pop = 0.001
          }
        } else {
          penClick()
        }
      } else if (!this.opened) {
        // Settled: click the tab to open.
        const tab = this.tabPos()
        if (Math.hypot(pointer.x - tab.x, pointer.y - tab.y) < 70 * this.s) {
          this.opened = true
          this.won = true
          this.openAt = 0
          pssh(false)
          services.shake('thud', 0.8)
          services.impactFrame(2)
          return 'won'
        }
        penClick()
      }
    }

    // Bubbles fizz and popped ones vanish.
    for (const b of this.bubbles) {
      if (b.pop > 0) b.pop += dt
    }

    // Timeout while still fizzing = eruption.
    if (ctx.remaining <= 0.0001 && !this.won) {
      this.erupted = true
      pssh(true)
      services.shake('slam')
      return 'lost'
    }
    return undefined
  }

  draw(ctx: MicroGameCtx): void {
    this.drawBubbles(ctx)
    this.drawCan(ctx)
    this.drawTargetZone(ctx)
    this.drawTapCount(ctx)
  }

  drawOutcome(ctx: MicroGameCtx, outcome: 'won' | 'lost', since: number): void {
    if (outcome === 'won') {
      this.drawCan(ctx)
      this.drawPour(ctx, since)
    } else {
      // "Violently spray neon-pink foam all over the notebook."
      this.drawCan(ctx, true)
      this.drawFoodFlood(ctx, since)
    }
  }

  private drawCan(ctx: MicroGameCtx, erupting = false): void {
    const { ink } = ctx
    const s = this.s
    const rng = makeRng('can', ink.boil)
    // Vibrate while pressurised.
    const shake = this.settled ? 0 : range(rng, -1, 1) * 5 * s
    const x = this.cx + shake
    const y = this.cy
    const w = this.cw
    const h = this.ch

    // Body — a crumpled cylinder. The left/right edges dent inward.
    const dent = 10 * s
    const body: Pt[] = [
      { x: x - w / 2, y: y - h / 2 + 12 * s },
      { x: x - w / 2 + dent, y: y - h * 0.2 },
      { x: x - w / 2, y: y },
      { x: x - w / 2 + dent * 0.6, y: y + h * 0.3 },
      { x: x - w / 2, y: y + h / 2 - 12 * s },
      { x: x + w / 2, y: y + h / 2 - 12 * s },
      { x: x + w / 2 - dent, y: y + h * 0.2 },
      { x: x + w / 2, y: y - h * 0.1 },
      { x: x + w / 2 - dent * 0.5, y: y - h * 0.3 },
      { x: x + w / 2, y: y - h / 2 + 12 * s }
    ]
    ink.fill(body, erupting ? '#d8dae0' : '#e2e4ea', 0.95)
    ink.shape('soda-body', body, { width: 6 * s, passes: 2, bleed: true })
    // A colour band + a scribbled label.
    ink.fill([
      { x: x - w / 2, y: y - h * 0.06 }, { x: x + w / 2, y: y - h * 0.06 },
      { x: x + w / 2, y: y + h * 0.16 }, { x: x - w / 2, y: y + h * 0.16 }
    ], '#c62828', 0.85)
    inkText(ink, 'soda-label', 'FIZZ', x, y + h * 0.05, w * 0.34, {
      align: 'center', baseline: 'middle', color: NOTEBOOK.paper, width: w * 0.03, tilt: 0.06
    })

    // Top rim + the tab.
    ink.ellipse('soda-rim', x, y - h / 2 + 12 * s, w * 0.5, 12 * s, 0, { width: 5 * s, passes: 2 })
    const tab = this.tabPos()
    const tabWob = this.settled ? 0 : range(rng, -1, 1) * 4 * s
    ink.ctx.save()
    ink.ctx.translate(tab.x + tabWob, tab.y)
    ink.shape('soda-tab', [
      { x: -16 * s, y: 0 }, { x: 16 * s, y: -3 * s }, { x: 14 * s, y: 12 * s }, { x: -14 * s, y: 12 * s }
    ], { width: 4 * s, passes: 2 })
    ink.circle('soda-tabhole', 0, 4 * s, 5 * s, { width: 3 * s, passes: 1 })
    ink.ctx.restore()
  }

  private drawBubbles(ctx: MicroGameCtx): void {
    const { ink, t } = ctx
    const s = this.s
    for (let i = 0; i < this.bubbles.length; i++) {
      const b = this.bubbles[i]!
      if (b.pop > 0.2) continue
      // Orbit the can, bobbing.
      const rad = (this.cw * 0.6 + b.r * this.cw * 0.3)
      const bx = this.cx + Math.cos(b.a + t * 0.6) * rad
      const by = this.cy + Math.sin(b.a + t * 0.9) * (this.ch * 0.4) * b.r
      const popScale = b.pop > 0 ? 1 + b.pop * 6 : 1
      const alpha = b.pop > 0 ? Math.max(0, 0.7 - b.pop * 4) : 0.6
      ink.circle(`soda-bub${i}`, bx, by, b.rad * s * popScale, {
        color: HIGHLIGHT.pink, width: 3 * s, passes: 1, alpha
      })
    }
  }

  /** The active target: side zone while pressurised, tab once settled. */
  private drawTargetZone(ctx: MicroGameCtx): void {
    const { ink, t } = ctx
    const s = this.s
    const pulse = 0.4 + Math.sin(t * 9) * 0.18
    if (!this.settled) {
      const z = this.sideZone()
      ink.highlightBlob('soda-zone', z.x + z.w * 0.5, z.y + z.h * 0.5, z.w * 0.55, 'yellow', pulse * 0.7)
      // A little "tap here" tap-target ring.
      ink.circle('soda-zonering', z.x + z.w * 0.5, z.y + z.h * 0.5, z.w * 0.32, {
        color: HIGHLIGHT.yellow, width: 5 * s, passes: 1, alpha: 0.8
      })
    } else if (!this.opened) {
      const tab = this.tabPos()
      ink.highlightBlob('soda-tabzone', tab.x, tab.y, 44 * s, 'green', pulse)
      ink.circle('soda-tabring', tab.x, tab.y, 30 * s, {
        color: HIGHLIGHT.green, width: 5 * s, passes: 1, alpha: 0.9
      })
    }
  }

  /** Five clink pips. */
  private drawTapCount(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    const st = ink.stage
    for (let i = 0; i < TAPS_NEEDED; i++) {
      const cx = st.cx + (i - (TAPS_NEEDED - 1) / 2) * 34 * s
      const cy = st.y + st.h * 0.12
      const hit = i < this.taps
      ink.circle(`soda-pip${i}`, cx, cy, 11 * s, {
        color: hit ? HIGHLIGHT.green : NOTEBOOK.inkSoft, width: 3.4 * s, passes: 1, alpha: hit ? 1 : 0.6
      })
      if (hit) ink.fillCircle(cx, cy, 7 * s, HIGHLIGHT.green, 0.85)
    }
  }

  /** A neat pouring stream on success. */
  private drawPour(ctx: MicroGameCtx, since: number): void {
    const { ink } = ctx
    const s = this.s
    const tab = this.tabPos()
    const len = Math.min(1, since * 2) * this.ch * 0.6
    const rng = makeRng('pour', ink.boil)
    ink.stroke('soda-pour', [
      { x: tab.x, y: tab.y },
      { x: tab.x - 20 * s + range(rng, -3, 3) * s, y: tab.y + len * 0.5 },
      { x: tab.x - 40 * s, y: tab.y + len }
    ], { color: '#8a4a10', width: 8 * s, passes: 2, alpha: 0.85 })
    // A little steam of carbonation off the top.
    for (let i = 0; i < 3; i++) {
      ink.circle(`soda-fizz${i}`, tab.x + range(rng, -14, 14) * s, tab.y - 10 * s - i * 12 * s,
        range(rng, 2, 5) * s, { color: HIGHLIGHT.pink, width: 2 * s, passes: 1, alpha: 0.6 })
    }
  }

  /** Pink foam flooding the page on failure. */
  private drawFoodFlood(ctx: MicroGameCtx, since: number): void {
    const { ink } = ctx
    const s = this.s
    const grow = Math.min(1, since * 1.6)
    const rng = makeRng('flood', 0)
    // A rising tide of foam from the can.
    for (let i = 0; i < Math.floor(grow * 26); i++) {
      const a = range(rng, -Math.PI, 0)
      const d = grow * ink.stage.w * range(rng, 0.2, 0.9)
      ink.fillCircle(
        this.cx + Math.cos(a) * d,
        this.cy - this.ch * 0.4 + Math.sin(a) * d * 0.6 + (1 - grow) * 40 * s,
        range(rng, 12, 34) * s, HIGHLIGHT.pink, 0.55)
    }
    if (since > 0.2) {
      inkText(ink, 'soda-boom', ctx.services.t('game.soda.spray'), ink.stage.cx, ink.stage.cy,
        ink.stage.w * 0.12, {
        align: 'center', baseline: 'middle', color: NOTEBOOK.ink,
        width: ink.stage.w * 0.014, bleed: true, rotate: -0.06, tilt: 0.1
      })
    }
  }
}

export const sodaExplode = (): MicroGame => new SodaExplode()
