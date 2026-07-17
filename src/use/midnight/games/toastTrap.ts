// ─── Micro-game: Toast Trap — "CATCH!" ─────────────────────────────────────
//
// vision-board-minigames §4. A sketch toaster sits at the bottom, slots glowing
// neon-orange. The cursor is a wide-open mitt. After a tense 1–3s delay two
// slices launch; move left/right to catch both mid-air before they fall past
// the toaster. DING + steam on a catch; a miss lands as burnt charcoal.
//
// ── The catch model ──
// The mitt tracks the pointer's X only (it sits at a fixed catch height). A
// toast is caught when it passes through the mitt's Y band within the mitt's
// width. Both slices must be caught; one missed slice is a loss. The launch
// delay is the whole tension — a coiled-spring wait, then chaos.

import type { MicroGame, MicroGameCtx } from '../types'
import { NOTEBOOK, HIGHLIGHT } from '@/use/ink/palette'
import { mulberry32, range, makeRng } from '@/use/ink/rng'
import { ding, penClick } from '@/use/ink/useInkAudio'
import type { Pt } from '@/use/ink/inkRenderer'

interface Toast {
  x: number
  y: number
  vx: number
  vy: number
  rot: number
  spin: number
  caught: boolean
  missed: boolean
  settleAt: number
  /** Seconds before this slice actually launches (staggered — see `launch`).
   *  Until then it sits in its slot. */
  delay: number
}

class ToastTrap implements MicroGame {
  readonly id = 'toast'
  readonly verbKey = 'game.toast.verb'
  readonly hintKey = 'game.toast.hint'
  readonly baseDuration = 5

  private rng: () => number = Math.random
  private s = 1
  private toasterX = 0
  private toasterY = 0
  private catchY = 0
  private mittX = 0
  /** Countdown to launch, seconds. */
  private fuse = 0
  private launched = false
  private toasts: Toast[] = []
  private caught = 0
  private steamAt = -1
  private rumble = 0

  init(ctx: MicroGameCtx, seed: number): void {
    const { ink } = ctx
    const st = ink.stage
    this.rng = mulberry32(seed)
    this.s = st.w * 0.0016
    this.toasterX = st.cx
    this.toasterY = st.y + st.h * 0.82
    // The catch line MUST sit inside the toasts' arc, or the game is literally
    // impossible. With gravity `900*s` and the launch speeds in `launch()`, a
    // slice peaks ~0.33·stageH above the toaster; putting the catch line at
    // 0.52 (0.30·stageH above the toaster) leaves it comfortably below every
    // peak and above the "fell past" line, so both a fast and a slow launch
    // pass through it on the way down. (The original 0.40 was ABOVE the peak —
    // the toasts never reached it, which is why only the fastest slice ever
    // got caught.) See the launch-speed note in `launch`.
    this.catchY = st.y + st.h * 0.52
    this.mittX = st.cx
    // The spec's tense 1–3s wait, capped: the second slice is launch-delayed
    // ~0.55s and each arc is ~1.5s, so the fuse must leave room for all of it
    // inside the 5s clock. 0.8–1.8s does.
    this.fuse = range(this.rng, 0.8, 1.8)
    this.launched = false
    this.toasts = []
    this.caught = 0
    this.steamAt = -1
    this.rumble = 0
  }

  /** Dev-only view (GameScene's `__midnight.state().detail`). */
  debug() {
    return {
      launched: this.launched, caught: this.caught, catchY: Math.round(this.catchY),
      toasts: this.toasts.map((t) => ({ x: Math.round(t.x), y: Math.round(t.y), vy: Math.round(t.vy), done: t.caught || t.missed }))
    }
  }

  update(ctx: MicroGameCtx, dt: number) {
    const { pointer, services } = ctx
    if (this.steamAt >= 0) this.steamAt += dt

    // The mitt follows the pointer's X, clamped to the stage.
    if (pointer.seen) {
      const st = ctx.ink.stage
      this.mittX = Math.max(st.x + 40 * this.s, Math.min(st.x + st.w - 40 * this.s, pointer.x))
    }

    if (!this.launched) {
      this.fuse -= dt
      // The toaster rattles harder as launch nears — the tension tell.
      this.rumble = Math.max(0, 1 - this.fuse / 0.6)
      if (this.fuse <= 0) {
        this.launch(ctx)
        services.shake('thud', 0.8)
      }
      return undefined
    }

    // Fly the toasts.
    for (const tst of this.toasts) {
      if (tst.caught || tst.missed) {
        if (tst.settleAt >= 0) tst.settleAt += dt
        continue
      }
      // A staggered slice waits in its slot until its delay elapses, then pops.
      if (tst.delay > 0) {
        tst.delay -= dt
        continue
      }
      tst.vy += 900 * this.s * dt
      tst.x += tst.vx * dt
      tst.y += tst.vy * dt
      tst.rot += tst.spin * dt

      // Catch test: descending through the mitt band, within the mitt's grasp.
      // The band is generous vertically (±30·s) because a fast slice only
      // spends a couple of frames near the line, and horizontally (mitt half-
      // width) because this must be forgiving on a phone.
      const mittW = 66 * this.s
      if (tst.vy > 0 && Math.abs(tst.y - this.catchY) < 30 * this.s
          && Math.abs(tst.x - this.mittX) < mittW) {
        tst.caught = true
        tst.settleAt = 0
        this.caught++
        this.steamAt = 0
        ding()
        services.shake('snap', 0.7)
        services.impactFrame(1)
        if (this.caught >= this.toasts.length) return 'won'
      } else if (tst.y > this.toasterY + 120 * this.s) {
        // Fell past — burnt.
        tst.missed = true
        tst.settleAt = 0
        penClick()
        services.shake('tick')
        return 'lost'
      }
    }
    return undefined
  }

  private launch(ctx: MicroGameCtx): void {
    this.launched = true
    // The two slices are staggered in TIME: the first pops immediately, the
    // second ~0.55s later. If both launched at once with the same upward speed
    // they would descend through the mitt height at the same instant but
    // different X positions — un-catchable with one hand. A launch-time
    // stagger guarantees the spec's "catch one, then dash to the other" rhythm
    // regardless of the exact arc physics, which arc-height staggering did not.
    // Randomise which side goes first so it can't be muscle-memorised.
    const firstDir = this.rng() < 0.5 ? -1 : 1
    for (let i = 0; i < 2; i++) {
      const dir = i === 0 ? -1 : 1
      const goesFirst = dir === firstDir
      this.toasts.push({
        x: this.toasterX + dir * 22 * this.s,
        y: this.toasterY - 30 * this.s,
        vx: dir * range(this.rng, 70, 130) * this.s,
        // ~760–860: enough to arc well above the catch line (which needs ≥700
        // to reach at all — see the catchY note in init) so it descends
        // through the mitt band rather than peaking short of it.
        vy: -range(this.rng, 760, 860) * this.s,
        rot: 0,
        spin: range(this.rng, -4, 4),
        caught: false,
        missed: false,
        settleAt: -1,
        delay: goesFirst ? 0 : range(this.rng, 0.5, 0.65)
      })
    }
  }

  draw(ctx: MicroGameCtx): void {
    this.drawToaster(ctx)
    this.drawToasts(ctx)
    this.drawMitt(ctx)
    this.drawSteam(ctx)
    this.drawCatchCount(ctx)
  }

  drawOutcome(ctx: MicroGameCtx, outcome: 'won' | 'lost', since: number): void {
    this.drawToaster(ctx)
    this.drawToasts(ctx, outcome === 'lost')
    this.drawMitt(ctx)
    this.drawSteam(ctx)
  }

  private drawToaster(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    const rng = makeRng('toaster', ink.boil)
    const shakeX = this.rumble * range(rng, -1, 1) * 6 * s
    const x = this.toasterX + shakeX
    const y = this.toasterY
    // Chrome body — a rounded retro loaf shape.
    ink.roundRect('tr-body', x - 80 * s, y - 30 * s, 160 * s, 96 * s, 30 * s, {
      color: '#c8ccd4', width: 6 * s, passes: 2, bleed: true
    })
    ink.ctx.save()
    ink.ctx.globalAlpha = 0.5
    ink.fillCircle(x, y + 20 * s, 70 * s, '#e4e8ee', 1)
    ink.ctx.restore()
    // Two slots, glowing orange.
    for (let i = 0; i < 2; i++) {
      const sx = x + (i === 0 ? -34 : 34) * s
      ink.highlightBlob(`tr-slotglow${i}`, sx, y - 24 * s, 26 * s, 'orange', 0.4)
      ink.roundRect('tr-slot' + i, sx - 22 * s, y - 34 * s, 44 * s, 16 * s, 6 * s, {
        width: 4 * s, passes: 1, color: NOTEBOOK.ink
      })
      ink.fill([
        { x: sx - 18 * s, y: y - 30 * s }, { x: sx + 18 * s, y: y - 30 * s },
        { x: sx + 18 * s, y: y - 22 * s }, { x: sx - 18 * s, y: y - 22 * s }
      ], HIGHLIGHT.orange, 0.6)
    }
    // Lever + dial.
    ink.roundRect('tr-lever', x + 78 * s, y - 6 * s, 16 * s, 30 * s, 6 * s, { width: 4 * s, passes: 1 })
    ink.circle('tr-dial', x - 60 * s, y + 46 * s, 12 * s, { width: 4 * s, passes: 1 })
  }

  private drawToasts(ctx: MicroGameCtx, ruinedFlourish = false): void {
    const { ink } = ctx
    const s = this.s
    for (let i = 0; i < this.toasts.length; i++) {
      const tst = this.toasts[i]!
      ink.transformed(tst.x, tst.y, tst.rot, 1, () => {
        const burnt = tst.missed
        // Bread slice: a rounded-top square.
        const pts: Pt[] = [
          { x: -26 * s, y: 24 * s },
          { x: -26 * s, y: -8 * s },
          { x: -14 * s, y: -24 * s },
          { x: 14 * s, y: -24 * s },
          { x: 26 * s, y: -8 * s },
          { x: 26 * s, y: 24 * s }
        ]
        if (burnt) {
          // Charcoal scribble.
          ink.fill(pts, '#2a2a2e', 0.92)
          ink.shape(`toast${i}`, pts, { width: 4 * s, passes: 2, rough: 5 })
          const rng = makeRng(`burn${i}`, ink.boil)
          for (let k = 0; k < 5; k++) {
            ink.stroke(`burnmark${i}${k}`, [
              { x: range(rng, -22, 22) * s, y: range(rng, -18, 18) * s },
              { x: range(rng, -22, 22) * s, y: range(rng, -18, 18) * s }
            ], { color: '#000', width: 3 * s, passes: 1, rough: 6, alpha: 0.6 })
          }
        } else {
          ink.fill(pts, '#e0a94a', 0.95)
          ink.shape(`toast${i}`, pts, { width: 4.5 * s, passes: 2, bleed: true })
          // A pat of butter melting on top.
          ink.fill([
            { x: -8 * s, y: -6 * s }, { x: 8 * s, y: -6 * s },
            { x: 6 * s, y: 6 * s }, { x: -6 * s, y: 6 * s }
          ], '#fff0b0', 0.9)
        }
      })
    }
  }

  /** The catcher's mitt cursor — a wide-open glove at the catch height. */
  private drawMitt(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    const x = this.mittX
    const y = this.catchY
    ink.highlightBlob('tr-mitthl', x, y, 46 * s, 'cyan', 0.28)
    // Palm.
    const palm: Pt[] = [
      { x: x - 40 * s, y: y + 8 * s },
      { x: x - 44 * s, y: y - 20 * s },
      { x: x - 20 * s, y: y - 34 * s },
      { x: x + 20 * s, y: y - 34 * s },
      { x: x + 44 * s, y: y - 20 * s },
      { x: x + 40 * s, y: y + 8 * s },
      { x: x + 24 * s, y: y + 30 * s },
      { x: x - 24 * s, y: y + 30 * s }
    ]
    ink.fill(palm, '#c08a4a', 0.95)
    ink.shape('tr-mitt', palm, { width: 5 * s, passes: 2, bleed: true })
    // Thumb.
    ink.shape('tr-thumb', [
      { x: x - 40 * s, y: y - 4 * s },
      { x: x - 58 * s, y: y - 10 * s },
      { x: x - 54 * s, y: y + 10 * s },
      { x: x - 38 * s, y: y + 12 * s }
    ], { width: 5 * s, passes: 2 })
    // Seam.
    ink.stroke('tr-seam', [
      { x: x - 24 * s, y: y + 26 * s }, { x: x, y: y - 10 * s }, { x: x + 24 * s, y: y + 26 * s }
    ], { width: 2.6 * s, passes: 1, alpha: 0.6 })
  }

  private drawSteam(ctx: MicroGameCtx): void {
    const { ink } = ctx
    if (this.steamAt < 0 || this.steamAt > 0.8) return
    const s = this.s
    const rng = makeRng('steam', ink.boil)
    const a = this.steamAt
    for (let i = 0; i < 4; i++) {
      const x = this.mittX + range(rng, -20, 20) * s
      const y = this.catchY - 20 * s - a * 120 * s - i * 10 * s
      ink.stroke(`tr-steam${i}`, [
        { x, y }, { x: x + range(rng, -12, 12) * s, y: y - 24 * s }
      ], { color: '#ffffff', width: 5 * s, passes: 1, alpha: Math.max(0, 0.6 - a) })
    }
  }

  /** Two pips showing catches. */
  private drawCatchCount(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    const st = ink.stage
    for (let i = 0; i < 2; i++) {
      const cx = st.cx + (i === 0 ? -24 : 24) * s
      const cy = st.y + st.h * 0.12
      const hit = i < this.caught
      ink.fill([
        { x: cx - 12 * s, y: cy + 10 * s }, { x: cx - 12 * s, y: cy - 4 * s },
        { x: cx, y: cy - 12 * s }, { x: cx + 12 * s, y: cy - 4 * s }, { x: cx + 12 * s, y: cy + 10 * s }
      ], hit ? '#e0a94a' : NOTEBOOK.paper, hit ? 0.9 : 1)
      ink.shape(`tr-pip${i}`, [
        { x: cx - 12 * s, y: cy + 10 * s }, { x: cx - 12 * s, y: cy - 4 * s },
        { x: cx, y: cy - 12 * s }, { x: cx + 12 * s, y: cy - 4 * s }, { x: cx + 12 * s, y: cy + 10 * s }
      ], { width: 3 * s, passes: 1, color: hit ? '#b5822f' : NOTEBOOK.inkSoft })
    }
  }
}

export const toastTrap = (): MicroGame => new ToastTrap()
