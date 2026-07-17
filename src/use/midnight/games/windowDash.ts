// ─── Micro-game: Window Dash — "SHUT!" ─────────────────────────────────────
//
// vision-board-minigames §2. Rain is blowing through an open window on the
// left. Neon-blue ink drops fly across the page toward your pristine
// sketchbook lines. Grab the neon-yellow slider on the window frame and drag it
// left→right in one swift motion to slam the window shut before three drops
// land.
//
// ── The win/lose shape ──
// Win = slider reaches the right edge (window shut). Lose = three drops reach
// the page, OR the clock runs out. Losing the drag partway is not a loss — you
// can grab it again — because the fantasy is a frantic shove, and one fumbled
// grab shouldn't end the round.

import type { MicroGame, MicroGameCtx } from '../types'
import { NOTEBOOK, HIGHLIGHT } from '@/use/ink/palette'
import { mulberry32, range, makeRng } from '@/use/ink/rng'
import { slam, penClick, gust } from '@/use/ink/useInkAudio'
import { inkText } from '@/use/ink/strokeFont'
import type { Pt } from '@/use/ink/inkRenderer'

const DROPS_TO_LOSE = 3

interface Drop {
  x: number
  y: number
  vx: number
  vy: number
  landed: boolean
  landedAt: number
  size: number
}

class WindowDash implements MicroGame {
  readonly id = 'window'
  readonly verbKey = 'game.window.verb'
  readonly hintKey = 'game.window.hint'
  readonly baseDuration = 5

  private rng: () => number = Math.random
  private s = 1
  /** Window rect, in page units. */
  private wx = 0
  private wy = 0
  private ww = 0
  private wh = 0
  /** Slider 0..1 across the window (0 open, 1 shut). */
  private shut = 0
  private grabbed = false
  private won = false
  /** Where the sash pane's right edge is, so the "glass" fills behind it. */
  private drops: Drop[] = []
  private landedCount = 0
  private spawnAcc = 0
  private gustAcc = 0

  init(ctx: MicroGameCtx, seed: number): void {
    const { ink } = ctx
    const st = ink.stage
    this.rng = mulberry32(seed)
    this.s = st.w * 0.0016
    this.shut = 0
    this.grabbed = false
    this.won = false
    this.drops = []
    this.landedCount = 0
    this.spawnAcc = 0
    this.gustAcc = 0

    // The window occupies the left ~55% of the stage; the open right portion is
    // where the rain blows in and where the page it's protecting sits.
    this.ww = st.w * 0.58
    this.wh = st.h * 0.6
    this.wx = st.x + st.w * 0.06
    this.wy = st.y + st.h * 0.16
  }

  /** Dev-only view (see GameScene's `__midnight.state().detail`). Exposes the
   *  handle's page-unit position so a scripted test can click it precisely —
   *  the rail sits low and eyeballed fractions miss it. */
  debug() {
    const h = this.handlePos()
    return { handle: { x: Math.round(h.x), y: Math.round(h.y) }, shut: +this.shut.toFixed(2), grabbed: this.grabbed }
  }

  /** The slider handle's current centre, in page units. Travels along the
   *  bottom rail of the window frame. */
  private handlePos(): Pt {
    return {
      x: this.wx + this.shut * this.ww,
      y: this.wy + this.wh + 26 * this.s
    }
  }

  update(ctx: MicroGameCtx, dt: number) {
    const { pointer, services } = ctx
    if (this.won) return undefined

    // ── Slider drag ──
    const h = this.handlePos()
    const grabR = 92 * this.s
    if (pointer.pressed) {
      if (Math.hypot(pointer.x - h.x, pointer.y - h.y) <= grabR) {
        this.grabbed = true
        penClick()
      }
    }
    if (pointer.released) this.grabbed = false
    if (this.grabbed) {
      const next = (pointer.x - this.wx) / this.ww
      // Monotonic-ish: the sash can slide back if you drag left, but that's the
      // player's mistake, not ours to prevent.
      this.shut = Math.max(0, Math.min(1, next))
      if (this.shut >= 0.985) {
        this.won = true
        slam()
        services.shake('slam')
        services.impactFrame(2)
        return 'won'
      }
    }

    // ── Rain blowing in through the still-open gap ──
    const gap = 1 - this.shut
    // A wind whoosh while it's open, quietening as it shuts — the "instant
    // sense of shelter" the spec asks for.
    this.gustAcc += dt
    if (gap > 0.1 && this.gustAcc > 0.5) {
      this.gustAcc = 0
      gust(gap * 0.5)
    }
    this.spawnAcc += dt * (2 + gap * 7)
    if (gap > 0.05 && this.spawnAcc >= 1) {
      this.spawnAcc = 0
      this.spawnDrop(ctx, gap)
    }
    for (const d of this.drops) {
      if (d.landed) { d.landedAt += dt; continue }
      d.x += d.vx * dt
      d.y += d.vy * dt
      // A drop "lands" when it clears the window's right edge into the open page.
      if (d.x > this.wx + this.ww + 30 * this.s) {
        d.landed = true
        d.landedAt = 0
        this.landedCount++
        services.shake('tick')
        if (this.landedCount >= DROPS_TO_LOSE) return 'lost'
      }
    }
    this.drops = this.drops.filter((d) => !d.landed || d.landedAt < 2)
    return undefined
  }

  private spawnDrop(ctx: MicroGameCtx, gap: number): void {
    // Drops enter through the OPEN part of the window (above the sash) and fly
    // rightward-down toward the page.
    const openTop = this.wy + 20 * this.s
    const openBottom = this.wy + this.wh - 20 * this.s
    const y = range(this.rng, openTop, openBottom)
    this.drops.push({
      x: this.wx + this.shut * this.ww + 10 * this.s,
      y,
      vx: range(this.rng, 220, 340) * this.s,
      vy: range(this.rng, 40, 130) * this.s,
      landed: false,
      landedAt: 0,
      size: range(this.rng, 9, 16) * this.s
    })
  }

  draw(ctx: MicroGameCtx): void {
    this.drawPageBehind(ctx)
    this.drawDrops(ctx)
    this.drawWindow(ctx)
    this.drawSlider(ctx)
    this.drawStormCount(ctx)
  }

  drawOutcome(ctx: MicroGameCtx, outcome: 'won' | 'lost', since: number): void {
    const { ink } = ctx
    this.drawPageBehind(ctx, outcome === 'lost')
    this.drawDrops(ctx)
    this.drawWindow(ctx)
    this.drawSlider(ctx)
    if (outcome === 'won') {
      // "SLAM!" and a burst of calm.
      const pop = Math.min(1, since / 0.1)
      inkText(ink, 'win-slam', ctx.services.t('game.window.slam'), ink.stage.cx, ink.stage.y + ink.stage.h * 0.42,
        ink.stage.w * 0.12 * pop, {
        align: 'center', baseline: 'middle', color: NOTEBOOK.markerRed,
        width: ink.stage.w * 0.014, bleed: true, rotate: -0.08, tilt: 0.09,
        alpha: Math.max(0, 1 - Math.max(0, (since - 0.5) / 0.4))
      })
    }
  }

  /** The pristine sketchbook the rain threatens. Splotches appear where drops
   *  have landed. */
  private drawPageBehind(ctx: MicroGameCtx, ruined = false): void {
    const { ink } = ctx
    // Landed-drop splotches on the open page.
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i]!
      if (!d.landed) continue
      const spread = Math.min(1, d.landedAt * 2)
      ink.highlightBlob(`splot${i}`, d.x, d.y, d.size * (1 + spread * 2.5), 'cyan', 0.5)
      ink.splatter(`splotink${i}`, d.x, d.y, d.size * 0.7, '#2a5aa8', 6, 2.4)
    }
    if (ruined) {
      // A last drenching flourish.
      const rng = makeRng('drench', 0)
      for (let i = 0; i < 8; i++) {
        ink.splatter(`drench${i}`, this.wx + this.ww + range(rng, 20, 220) * this.s,
          this.wy + range(rng, 0, this.wh), range(rng, 10, 26) * this.s, '#2a5aa8', 8, 3)
      }
    }
  }

  /** The rain drops in flight — stretched neon-blue ink teardrops with trails. */
  private drawDrops(ctx: MicroGameCtx): void {
    const { ink } = ctx
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i]!
      if (d.landed) continue
      const ang = Math.atan2(d.vy, d.vx)
      // Motion trail.
      ink.stroke(`droptrail${i}`, [
        { x: d.x - Math.cos(ang) * d.size * 3, y: d.y - Math.sin(ang) * d.size * 3 },
        { x: d.x, y: d.y }
      ], { color: HIGHLIGHT.cyan, width: d.size * 0.7, passes: 1, alpha: 0.5 })
      // Teardrop head.
      ink.transformed(d.x, d.y, ang, 1, () => {
        ink.fill([
          { x: -d.size, y: 0 },
          { x: d.size * 0.4, y: -d.size * 0.7 },
          { x: d.size, y: 0 },
          { x: d.size * 0.4, y: d.size * 0.7 }
        ], '#2a6ad8', 0.9)
      })
    }
  }

  private drawWindow(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    // Frame.
    ink.rect('win-frame', this.wx, this.wy, this.ww, this.wh, { width: 7 * s, passes: 2, bleed: true })
    // The stormy sky visible through the open gap (right of the sash).
    const sashX = this.wx + this.shut * this.ww
    ink.ctx.save()
    ink.ctx.beginPath()
    ink.ctx.rect(sashX, this.wy, this.wx + this.ww - sashX, this.wh)
    ink.ctx.clip()
    ink.ctx.fillStyle = '#3a4a68'
    ink.ctx.fillRect(sashX, this.wy, this.ww, this.wh)
    // Diagonal rain streaks in the gap.
    const rng = makeRng('winrain', ink.boil)
    for (let i = 0; i < 14; i++) {
      const rx = range(rng, sashX, this.wx + this.ww)
      const ry = range(rng, this.wy, this.wy + this.wh)
      ink.stroke(`winrain${i}`, [
        { x: rx, y: ry }, { x: rx + 22 * s, y: ry + 40 * s }
      ], { color: '#9ac0ff', width: 2.4 * s, passes: 1, alpha: 0.5 })
    }
    ink.ctx.restore()

    // The sliding sash (the "glass" pane you're pushing across).
    ink.ctx.save()
    ink.ctx.globalAlpha = 0.28
    ink.ctx.fillStyle = '#bcd4f0'
    ink.ctx.fillRect(this.wx, this.wy, this.shut * this.ww, this.wh)
    ink.ctx.restore()
    // Sash leading edge + a couple of muntins so it reads as a pane.
    ink.line('sash-edge', sashX, this.wy, sashX, this.wy + this.wh, { width: 6 * s, passes: 2 })
    ink.line('sash-mid', this.wx, this.wy + this.wh * 0.5, sashX, this.wy + this.wh * 0.5, {
      width: 3 * s, passes: 1, alpha: 0.6
    })
  }

  /** The neon-yellow slider handle on the bottom rail — the grab target. */
  private drawSlider(ctx: MicroGameCtx): void {
    const { ink, t } = ctx
    const s = this.s
    const h = this.handlePos()
    // The rail it travels along.
    ink.line('rail', this.wx, h.y, this.wx + this.ww, h.y, {
      color: NOTEBOOK.inkSoft, width: 5 * s, passes: 1, alpha: 0.6
    })
    // Pulsing highlight so the eye finds the handle inside the clock.
    const pulse = this.grabbed ? 0.6 : 0.35 + Math.sin(t * 8) * 0.15
    ink.highlightBlob('slider-hl', h.x, h.y, 44 * s, 'yellow', pulse)
    ink.roundRect('slider', h.x - 28 * s, h.y - 22 * s, 56 * s, 44 * s, 10 * s, {
      width: 5 * s, passes: 2, bleed: true
    })
    // Grip lines.
    for (let i = -1; i <= 1; i++) {
      ink.line(`grip${i}`, h.x + i * 10 * s, h.y - 12 * s, h.x + i * 10 * s, h.y + 12 * s, {
        width: 3 * s, passes: 1, alpha: 0.7
      })
    }
    // A "→" nudge when the player hasn't grabbed it yet.
    if (!this.grabbed && this.shut < 0.05) {
      ink.stroke('slider-arrow', [
        { x: h.x + 44 * s, y: h.y }, { x: h.x + 78 * s, y: h.y }
      ], { color: HIGHLIGHT.yellow, width: 6 * s, passes: 1 })
      ink.stroke('slider-arrowhead', [
        { x: h.x + 64 * s, y: h.y - 12 * s },
        { x: h.x + 78 * s, y: h.y },
        { x: h.x + 64 * s, y: h.y + 12 * s }
      ], { color: HIGHLIGHT.yellow, width: 6 * s, passes: 1 })
    }
  }

  /** Three raindrop pips showing how many landings remain. */
  private drawStormCount(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    const x0 = this.wx + this.ww + 40 * s
    const y = this.wy + 20 * s
    for (let i = 0; i < DROPS_TO_LOSE; i++) {
      const hit = i < this.landedCount
      const cx = x0
      const cy = y + i * 40 * s
      ink.fill([
        { x: cx - 8 * s, y: cy },
        { x: cx, y: cy - 14 * s },
        { x: cx + 8 * s, y: cy },
        { x: cx, y: cy + 8 * s }
      ], hit ? '#2a5aa8' : NOTEBOOK.paper, hit ? 0.9 : 1)
      ink.shape(`stormpip${i}`, [
        { x: cx - 8 * s, y: cy },
        { x: cx, y: cy - 14 * s },
        { x: cx + 8 * s, y: cy },
        { x: cx, y: cy + 8 * s }
      ], { width: 3 * s, passes: 1, color: hit ? '#2a5aa8' : NOTEBOOK.inkSoft })
    }
  }
}

export const windowDash = (): MicroGame => new WindowDash()
