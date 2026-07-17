// ─── Micro-game: Flashlight Flicker — "SMACK!" ─────────────────────────────
//
// vision-board-minigames §3. The page goes near-black, lit only by a weak,
// flickering cone from a hand-drawn flashlight at the bottom, its battery
// indicator flashing angry neon-pink. Rhythmically smack the flashlight three
// times — click anywhere — to seat the batteries. Third smack: the beam
// explodes into a steady spotlight revealing a smiling ghost that vanishes.
//
// ── Why this one draws over the page darkly ──
// Every other micro-game sits ON the lit notebook. This one deliberately kills
// the light: it paints a near-opaque dark veil over the whole page and only the
// torch cone cuts through it. That contrast is the entire mood, and it's the
// reason the reveal on the third smack lands.

import type { MicroGame, MicroGameCtx } from '../types'
import { NOTEBOOK, HIGHLIGHT } from '@/use/ink/palette'
import { makeRng, range, mulberry32 } from '@/use/ink/rng'
import { smack, chime } from '@/use/ink/useInkAudio'
import { inkText } from '@/use/ink/strokeFont'
import type { Pt } from '@/use/ink/inkRenderer'

const SMACKS_NEEDED = 3
/** Minimum gap between smacks that still counts as rhythmic. Faster than this
 *  is a double-tap, not a smack, and is ignored so a mash doesn't win it. */
const MIN_GAP = 0.18

class FlashlightFlicker implements MicroGame {
  readonly id = 'flashlight'
  readonly verbKey = 'game.flashlight.verb'
  readonly hintKey = 'game.flashlight.hint'
  readonly baseDuration = 5

  private smacks = 0
  private won = false
  private sinceSmack = 99
  private lastSmackAt = -99
  /** Seconds since the winning smack, for the reveal. */
  private revealAt = -1
  private rng: () => number = Math.random
  private s = 1
  private torchX = 0
  private torchY = 0
  /** Position of the last WHACK hand, page units. */
  private whackX = 0
  private whackY = 0
  private t = 0

  init(ctx: MicroGameCtx, seed: number): void {
    const { ink } = ctx
    const st = ink.stage
    this.rng = mulberry32(seed)
    this.smacks = 0
    this.won = false
    this.sinceSmack = 99
    this.lastSmackAt = -99
    this.revealAt = -1
    this.s = st.w * 0.0016
    this.torchX = st.cx
    this.torchY = st.y + st.h * 0.9
  }

  update(ctx: MicroGameCtx, dt: number) {
    const { pointer, services, t } = ctx
    this.t = t
    this.sinceSmack += dt
    if (this.revealAt >= 0) this.revealAt += dt
    if (this.won) return undefined

    if (pointer.pressed && (t - this.lastSmackAt) >= MIN_GAP) {
      this.lastSmackAt = t
      this.sinceSmack = 0
      this.smacks++
      this.whackX = pointer.x
      this.whackY = pointer.y
      smack()
      services.shake('snap', 1 + this.smacks * 0.3)
      services.impactFrame(2)
      if (this.smacks >= SMACKS_NEEDED) {
        this.won = true
        this.revealAt = 0
        chime(3)
        services.shake('slam')
        services.impactFrame(3)
        return 'won'
      }
    }
    return undefined
  }

  draw(ctx: MicroGameCtx): void {
    this.drawDarkness(ctx, this.won ? 1 : 0)
    this.drawTorch(ctx)
    this.drawBattery(ctx)
    this.drawWhack(ctx)
    this.drawSmackPips(ctx)
  }

  drawOutcome(ctx: MicroGameCtx, outcome: 'won' | 'lost', since: number): void {
    if (outcome === 'won') {
      // The beam explodes to a steady spotlight, revealing the ghost.
      this.drawDarkness(ctx, since)
      this.drawGhost(ctx, since)
      this.drawTorch(ctx, true)
    } else {
      // Stays dark — the batteries never seated.
      this.drawDarkness(ctx, 0)
      this.drawTorch(ctx)
      this.drawBattery(ctx)
    }
  }

  /**
   * The dark veil over the page, with a warm pool of torchlight left in it.
   * `light` 0..1 lifts the darkness on the win.
   *
   * ── Why this is one source-over gradient, not an erased cone ──
   * The presented canvas is opaque (`alpha: false` in useInkCanvas), so a
   * `destination-out` "punch a hole in the dark" carves through to the black
   * canvas BACKING, not to the paper beneath — the cone comes out blacker than
   * the veil, which is the exact inversion this originally shipped with. So the
   * veil is instead painted as a single radial gradient that is TRANSPARENT
   * over the torch (leaving the paper + linework showing) and opaque-dark at
   * the page edges. No compositing tricks, nothing to invert.
   */
  private drawDarkness(ctx: MicroGameCtx, light: number): void {
    const { ink } = ctx
    const st = ink.stage
    // The beam gutters while the batteries are loose — reach and brightness
    // flicker on a fast noise, which is most of the tension.
    const flickerRng = makeRng('flick', ink.boil)
    const flicker = this.won ? 1 : range(flickerRng, 0.55, 0.9)
    // Pool centred a little above the torch (the beam reaches up the page).
    const px = this.torchX
    const py = this.torchY - st.h * (this.won ? 0.42 : 0.3) * flicker
    const reach = (this.won ? 1.4 : 0.5 + flicker * 0.28) * st.h * 0.6

    // The veil: transparent in the pool, dark at the rim. `light` lifts the
    // whole thing on the win so the page returns.
    const edgeDark = 0.9 * (1 - light * 0.97)
    const poolDark = 0.16 * (1 - light)
    const g = ink.ctx.createRadialGradient(px, py, reach * 0.1, px, py, reach)
    g.addColorStop(0, `rgba(8,11,24,${poolDark})`)
    g.addColorStop(0.55, `rgba(8,11,24,${poolDark + (edgeDark - poolDark) * 0.5})`)
    g.addColorStop(1, `rgba(8,11,24,${edgeDark})`)
    ink.ctx.save()
    ink.ctx.fillStyle = g
    ink.ctx.fillRect(st.x - 60, st.y - 60, st.w + 120, st.h + 120)
    ink.ctx.restore()

    // A warm amber wash added INSIDE the pool, so the torchlight reads as warm
    // rather than merely "less dark". 'screen' can only lighten, so it can't
    // re-darken anything if the maths drifts.
    ink.ctx.save()
    ink.ctx.globalCompositeOperation = 'screen'
    ink.ctx.globalAlpha = this.won ? 0.45 : 0.28 * flicker
    const wg = ink.ctx.createRadialGradient(px, py, reach * 0.1, px, py, reach * 0.85)
    wg.addColorStop(0, this.won ? '#fff6cc' : '#ffcf8a')
    wg.addColorStop(1, 'rgba(0,0,0,0)')
    ink.ctx.fillStyle = wg
    ink.ctx.fillRect(st.x - 60, st.y - 60, st.w + 120, st.h + 120)
    ink.ctx.restore()
  }

  /** The brass torch at the bottom of the page. `blazing` on the win. */
  private drawTorch(ctx: MicroGameCtx, blazing = false): void {
    const { ink } = ctx
    const s = this.s
    const x = this.torchX
    const y = this.torchY
    // Barrel.
    ink.ctx.save()
    ink.ctx.translate(x, y)
    // Head (the reflector), opening upward.
    ink.shape('fl-head', [
      { x: -34 * s, y: 0 },
      { x: 34 * s, y: 0 },
      { x: 22 * s, y: 46 * s },
      { x: -22 * s, y: 46 * s }
    ], { width: 5 * s, passes: 2, bleed: true })
    // Body.
    ink.rect('fl-body', -22 * s, 46 * s, 44 * s, 90 * s, { width: 5 * s, passes: 2 })
    // Lens glow.
    ink.fillCircle(0, 6 * s, 26 * s, blazing ? HIGHLIGHT.yellow : '#ffcf8a', blazing ? 0.9 : 0.5)
    ink.ctx.restore()
  }

  /** The angry neon-pink battery indicator — flashes until seated. */
  private drawBattery(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    const flash = Math.sin(this.t * 12) > 0
    const bx = this.torchX + 44 * s
    const by = this.torchY + 70 * s
    // How much charge is "seated" — grows with each smack.
    const seated = this.smacks / SMACKS_NEEDED
    ink.rect('fl-batt', bx, by, 40 * s, 22 * s, { width: 3 * s, passes: 1, color: HIGHLIGHT.pink })
    ink.rect('fl-batt-tip', bx + 40 * s, by + 6 * s, 6 * s, 10 * s, { width: 2 * s, passes: 1, color: HIGHLIGHT.pink })
    // Charge bars.
    for (let i = 0; i < 3; i++) {
      const on = i < Math.round(seated * 3);
      const fx = bx + 5 * s + i * 11 * s
      if (on || flash) {
        ink.fill([
          { x: fx, y: by + 4 * s }, { x: fx + 8 * s, y: by + 4 * s },
          { x: fx + 8 * s, y: by + 18 * s }, { x: fx, y: by + 18 * s }
        ], on ? HIGHLIGHT.green : HIGHLIGHT.pink, on ? 0.9 : (flash ? 0.8 : 0))
      }
    }
  }

  /** The comic "WHACK!" hand that slams down on each smack. */
  private drawWhack(ctx: MicroGameCtx): void {
    const { ink, services } = ctx
    const s = this.s
    if (this.sinceSmack > 0.3) return
    const age = this.sinceSmack
    const drop = Math.max(0, 1 - age / 0.08)
    const lift = Math.max(0, (age - 0.12) / 0.18)
    const alpha = 1 - lift
    const y = this.whackY - drop * 80 * s - lift * 60 * s
    ink.ctx.save()
    ink.ctx.globalAlpha = alpha
    // A crude fist.
    ink.fillCircle(this.whackX, y, 40 * s, '#f2d9c4', 0.95)
    ink.circle('fl-fist', this.whackX, y, 40 * s, { width: 5 * s, passes: 2 })
    for (let i = 0; i < 3; i++) {
      const kx = this.whackX - 20 * s + i * 20 * s
      ink.line(`fl-knuck${i}`, kx, y - 26 * s, kx, y - 8 * s, { width: 3 * s, passes: 1 })
    }
    // Impact star + WHACK! text.
    ink.actionLines('fl-whackline', this.whackX, y + 30 * s, 30 * s, 66 * s, 8, NOTEBOOK.markerRed)
    inkText(ink, 'fl-whack', services.t('game.flashlight.whack'), this.whackX + 50 * s, y - 30 * s, 34 * s, {
      align: 'center', baseline: 'middle', color: NOTEBOOK.markerRed,
      width: 4.6 * s, rotate: -0.2, tilt: 0.1
    })
    ink.ctx.restore()
  }

  /** Three pips (top area) showing smacks landed. */
  private drawSmackPips(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    const st = ink.stage
    for (let i = 0; i < SMACKS_NEEDED; i++) {
      const cx = st.cx + (i - 1) * 46 * s
      const cy = st.y + st.h * 0.14
      const hit = i < this.smacks
      ink.circle(`fl-pip${i}`, cx, cy, 14 * s, {
        color: hit ? HIGHLIGHT.yellow : '#5a5a66', width: 4 * s, passes: 1, alpha: hit ? 1 : 0.6
      })
      if (hit) ink.fillCircle(cx, cy, 9 * s, HIGHLIGHT.yellow, 0.85)
    }
  }

  /** The smiling ghost revealed by the steady beam — waves, then fades. */
  private drawGhost(ctx: MicroGameCtx, since: number): void {
    const { ink } = ctx
    const s = this.s
    const st = ink.stage
    const appear = Math.min(1, since / 0.2)
    const fade = Math.max(0, (since - 0.7) / 0.6)
    const alpha = appear * (1 - fade)
    if (alpha <= 0) return
    const gx = st.cx
    const gy = st.y + st.h * 0.44 - since * 30 * s
    ink.ctx.save()
    ink.ctx.globalAlpha = alpha
    // Classic sheet-ghost body: a domed top and a wavy hem.
    const body: Pt[] = [{ x: gx - 60 * s, y: gy + 70 * s }]
    for (let i = 0; i <= 10; i++) {
      const a = Math.PI - (i / 10) * Math.PI
      body.push({ x: gx + Math.cos(a) * 60 * s, y: gy - Math.sin(a) * 70 * s })
    }
    // Wavy hem back across the bottom.
    for (let i = 0; i <= 6; i++) {
      const f = i / 6
      body.push({ x: gx + 60 * s - f * 120 * s, y: gy + 70 * s + (i % 2 === 0 ? 0 : 16 * s) })
    }
    ink.fill(body, '#eaf2ff', 0.9)
    ink.shape('gh-body', body, { width: 4 * s, passes: 2, color: '#8aa8d0' })
    // Smiling face.
    for (let i = 0; i < 2; i++) {
      ink.fillCircle(gx + (i === 0 ? -20 : 20) * s, gy - 6 * s, 8 * s, NOTEBOOK.ink, 0.9)
    }
    ink.stroke('gh-smile', [
      { x: gx - 20 * s, y: gy + 22 * s },
      { x: gx, y: gy + 34 * s },
      { x: gx + 20 * s, y: gy + 22 * s }
    ], { width: 4 * s, passes: 1 })
    // A little wave.
    ink.stroke('gh-arm', [
      { x: gx - 54 * s, y: gy + 20 * s },
      { x: gx - 78 * s, y: gy + (Math.sin(since * 12) * 10 - 6) * s }
    ], { width: 8 * s, passes: 2, color: '#eaf2ff' })
    ink.ctx.restore()
  }
}

export const flashlightFlicker = (): MicroGame => new FlashlightFlicker()
