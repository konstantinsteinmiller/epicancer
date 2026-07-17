// ─── Micro-game: Shadow Jump — "LEAP!" ─────────────────────────────────────
//
// vision-board-minigames §10. Heat-mirage / too-hot-to-touch theme. A little
// ink-blot character runs along a scorching neon-orange pipeline. Spinning fan
// blades overhead cast the only safe cool spots: moving shadows. As the runner
// nears an unshaded, superheated stretch, a contracting ring appears on the
// next shadow. Tap the shadow as the ring aligns to leap there. Make three
// clean leaps to cross.
//
// Miss the beat and the runner lands on the bare hot pipe — bounces sky-high
// clutching its burning feet (fire-alarm) — a loss.
//
// The runner AUTO-advances toward the next gap; the ring's collapse is the cue
// to jump. So it's the shared ring mechanic, but the target is a moving shadow
// and the failure is spatial (you land on hot metal), which gives it a
// distinct, tense side-scroller read.

import type { MicroGame, MicroGameCtx } from '../types'
import { NOTEBOOK, HIGHLIGHT } from '@/use/ink/palette'
import { mulberry32, range, makeRng } from '@/use/ink/rng'
import { phew, alarm, sizzle } from '@/use/ink/useInkAudio'
import { inkText } from '@/use/ink/strokeFont'
import { type Ring, makeRing, stepRing, isHot, drawRing } from '../ring'
import type { InkRenderer, Pt } from '@/use/ink/inkRenderer'

const JUMPS_TO_WIN = 3

class ShadowJump implements MicroGame {
  readonly id = 'shadow'
  readonly verbKey = 'game.shadow.verb'
  readonly hintKey = 'game.shadow.hint'
  readonly baseDuration = 7

  private rng: () => number = Math.random
  private s = 1
  private pipeY = 0
  /** Runner's x + y (y for jump arc). */
  private rx = 0
  private ryOffset = 0
  /** The x of the current safe shadow the runner stands on. */
  private curShadow = 0
  /** The x of the next shadow to leap to, and the ring on it. */
  private nextShadow = 0
  private ring: Ring = { ring: 1, speed: 0.5 }
  private jumps = 0
  /** Jump animation: 0..1, or -1 when standing. */
  private jump = -1
  private jumpFrom = 0
  private jumpTo = 0
  private burned = false
  private burnAt = 0
  private phewAt = 99
  private won = false
  /** Fan blade rotation. */
  private bladeRot = 0
  private runPhase = 0

  init(ctx: MicroGameCtx, seed: number): void {
    const { ink } = ctx
    const st = ink.stage
    this.rng = mulberry32(seed)
    this.s = st.w * 0.0016
    this.pipeY = st.y + st.h * 0.6
    this.jumps = 0
    this.jump = -1
    this.burned = false
    this.won = false
    this.phewAt = 99
    this.bladeRot = 0
    this.runPhase = 0

    // The runner starts on a shadow at the left; the next shadow is ahead.
    this.rx = st.x + st.w * 0.22
    this.curShadow = this.rx
    this.ryOffset = 0
    this.nextShadow = this.rx + st.w * 0.28
    this.ring = makeRing(0, this.rng)
  }

  update(ctx: MicroGameCtx, dt: number) {
    const { pointer, services } = ctx
    const st = ctx.ink.stage
    this.bladeRot += dt * 3
    this.runPhase += dt * 12
    if (this.phewAt < 90) this.phewAt += dt
    if (this.burned) { this.burnAt += dt; return undefined }
    if (this.won) return undefined

    if (this.jump >= 0) {
      // Mid-leap: arc from → to.
      this.jump = Math.min(1, this.jump + dt * 3.2)
      this.rx = this.jumpFrom + (this.jumpTo - this.jumpFrom) * this.jump
      this.ryOffset = -Math.sin(this.jump * Math.PI) * 120 * this.s
      if (this.jump >= 1) {
        // Landed safely on the next shadow.
        this.jump = -1
        this.ryOffset = 0
        this.curShadow = this.jumpTo
        this.jumps++
        this.phewAt = 0
        phew()
        services.shake('tick', 0.6)
        if (this.jumps >= JUMPS_TO_WIN) { this.won = true; return 'won' }
        // Set up the next gap + ring.
        this.nextShadow = this.curShadow + st.w * range(this.rng, 0.24, 0.32)
        // If it would run off the page, wrap the layout leftward (the world
        // scrolls conceptually — we just reset positions to keep it on screen).
        if (this.nextShadow > st.x + st.w - st.w * 0.15) {
          const shift = this.curShadow - (st.x + st.w * 0.22)
          this.curShadow -= shift
          this.rx -= shift
          this.nextShadow -= shift
        }
        this.ring = makeRing(this.jumps, this.rng)
      }
      return undefined
    }

    // Standing: the ring on the next shadow contracts — leap when it aligns.
    stepRing(this.ring, dt)
    if (pointer.pressed) {
      const d = Math.hypot(pointer.x - this.nextShadow, pointer.y - this.pipeY)
      const hitR = 96 * this.s
      if (d < hitR) {
        if (isHot(this.ring)) {
          this.jumpFrom = this.rx
          this.jumpTo = this.nextShadow
          this.jump = 0
        } else {
          this.missBurn(ctx)
        }
      } else {
        // A tap nowhere near the shadow also fails the leap (you hesitated).
        this.missBurn(ctx)
      }
    }
    return undefined
  }

  private missBurn(ctx: MicroGameCtx): void {
    this.burned = true
    this.burnAt = 0
    sizzle()
    alarm()
    ctx.services.shake('rip')
    ctx.services.impactFrame(2)
  }

  draw(ctx: MicroGameCtx): void {
    this.drawBackdrop(ctx)
    this.drawPipe(ctx)
    this.drawShadows(ctx)
    this.drawBlades(ctx)
    this.drawRunner(ctx)
    if (this.jump < 0) {
      const { ink } = ctx
      drawRing(ink, 'shadowring', this.nextShadow, this.pipeY, 44 * this.s, this.ring, {
        cool: 'cyan', hot: 'yellow', reach: 74 * this.s, width: 6 * this.s
      })
    }
    if (this.phewAt < 0.5) this.drawPhew(ctx)
    this.drawTally(ctx)
  }

  drawOutcome(ctx: MicroGameCtx, outcome: 'won' | 'lost', since: number): void {
    this.drawBackdrop(ctx)
    this.drawPipe(ctx)
    this.drawShadows(ctx)
    this.drawBlades(ctx)
    if (outcome === 'lost') this.drawBurnedRunner(ctx, since)
    else { this.drawRunner(ctx); if (this.phewAt < 0.5) this.drawPhew(ctx) }
  }

  private drawBackdrop(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const st = ink.stage
    ink.ctx.save()
    ink.ctx.globalAlpha = 0.12
    ink.ctx.fillStyle = '#ffcaa0'
    ink.ctx.fillRect(st.x, st.y, st.w, st.h)
    ink.ctx.restore()
  }

  /** The scorching pipeline — a thick horizontal pipe glowing neon-orange. */
  private drawPipe(ctx: MicroGameCtx): void {
    const { ink, t } = ctx
    const st = ink.stage
    const s = this.s
    const y = this.pipeY
    const h = 40 * s
    // Heat glow radiating up off the pipe.
    ink.ctx.save()
    ink.ctx.globalCompositeOperation = 'screen'
    const g = ink.ctx.createLinearGradient(0, y - 60 * s, 0, y + 30 * s)
    g.addColorStop(0, 'rgba(255,90,26,0)')
    g.addColorStop(1, 'rgba(255,120,40,0.5)')
    ink.ctx.fillStyle = g
    ink.ctx.fillRect(st.x, y - 60 * s, st.w, 90 * s)
    ink.ctx.restore()
    // The pipe body.
    ink.fill([
      { x: st.x - 20, y: y + h / 2 }, { x: st.x - 20, y: y - h / 2 },
      { x: st.x + st.w + 20, y: y - h / 2 }, { x: st.x + st.w + 20, y: y + h / 2 }
    ], '#ff6a1a', 0.85)
    ink.line('pipe-top', st.x - 20, y - h / 2, st.x + st.w + 20, y - h / 2, { color: '#c8500e', width: 4 * s, passes: 2 })
    ink.line('pipe-bot', st.x - 20, y + h / 2, st.x + st.w + 20, y + h / 2, { color: '#c8500e', width: 4 * s, passes: 2 })
    // Bolt seams + shimmer marks on the hot metal.
    for (let i = 0; i < 8; i++) {
      const bx = st.x + (i + 0.5) / 8 * st.w
      ink.fillCircle(bx, y, 4 * s, '#c8500e', 0.7)
    }
    // Rising heat squiggles.
    const rng = makeRng('pipeheat', ink.boil)
    for (let i = 0; i < 6; i++) {
      const hx = st.x + range(rng, 0, st.w)
      ink.stroke(`pipesquig${i}`, [
        { x: hx, y: y - h / 2 - 4 * s }, { x: hx + 6 * s, y: y - h / 2 - 22 * s }, { x: hx - 4 * s, y: y - h / 2 - 40 * s }
      ], { color: HIGHLIGHT.orange, width: 2 * s, passes: 1, alpha: 0.3, rough: 2 })
    }
  }

  /** The cool shadows cast on the pipe — the safe landing spots. These are the
   *  goal, so they read clearly: a cool blue-grey pool with a crisp rim over
   *  the hot orange pipe. */
  private drawShadows(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    for (const [id, x] of [['cur', this.curShadow], ['next', this.nextShadow]] as const) {
      // A cool oval pool multiply-blended so the orange pipe shows through as a
      // dimmed, shaded patch — legibly "the cool spot".
      ink.ctx.save()
      ink.ctx.globalCompositeOperation = 'multiply'
      ink.fillCircle(x as number, this.pipeY, 58 * s, '#5a6a8a', 0.85)
      ink.ctx.restore()
      ink.ellipse(`shadow-${id}`, x as number, this.pipeY, 58 * s, 24 * s, 0, {
        color: '#2a3a5a', width: 3 * s, passes: 2, alpha: 0.75
      })
    }
  }

  /** Fan blades spinning overhead — the shadow casters. Kept compact and up top
   *  so they read as "that's what makes the shade" without dominating; the
   *  actual gameplay reads off the shadows on the pipe below. */
  private drawBlades(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const st = ink.stage
    const s = this.s
    for (const [i, sx] of [this.curShadow, this.nextShadow].entries()) {
      const cy = st.y + st.h * 0.14
      // A thin, very faint beam hint from the fan to its shadow — a few sparse
      // motion lines, NOT a solid cone (that swamped the whole page).
      const rng = makeRng(`beam${i}`, ink.boil)
      for (let k = 0; k < 3; k++) {
        const bx = sx + range(rng, -28, 28) * s
        ink.stroke(`beam${i}${k}`, [
          { x: bx, y: cy + 20 * s }, { x: bx + range(rng, -10, 10) * s, y: this.pipeY - 20 * s }
        ], { color: '#8aa0c0', width: 2 * s, passes: 1, alpha: 0.14, rough: 1 })
      }
      ink.transformed(sx, cy, this.bladeRot * (i === 0 ? 1 : -1), 1, () => {
        for (let bIdx = 0; bIdx < 3; bIdx++) {
          const a = (bIdx / 3) * Math.PI * 2
          ink.fill([
            { x: 0, y: 0 },
            { x: Math.cos(a) * 42 * s, y: Math.sin(a) * 16 * s },
            { x: Math.cos(a + 0.5) * 48 * s, y: Math.sin(a + 0.5) * 20 * s },
            { x: Math.cos(a + 0.9) * 28 * s, y: Math.sin(a + 0.9) * 10 * s }
          ], '#6a6a72', 0.75)
        }
        // Blade outlines so they read as fan blades, not blobs.
        ink.circle(`fanhub${i}`, 0, 0, 9 * s, { color: NOTEBOOK.ink, width: 2.6 * s, passes: 1 })
        ink.fillCircle(0, 0, 6 * s, NOTEBOOK.ink)
      })
    }
  }

  /** The ink-blot runner, mid-stride or mid-leap. */
  private drawRunner(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    const x = this.rx
    const y = this.pipeY - 26 * s + this.ryOffset
    const jumping = this.jump >= 0
    const line = { color: NOTEBOOK.ink, width: 4.5 * s, passes: 2 } as const
    // A round ink-blot body.
    ink.fillCircle(x, y, 20 * s, NOTEBOOK.ink, 0.95)
    // Head.
    ink.fillCircle(x, y - 24 * s, 14 * s, NOTEBOOK.ink, 0.95)
    // Wide alarmed eyes (white dots).
    for (let e = -1; e <= 1; e += 2) {
      ink.fillCircle(x + e * 5 * s, y - 26 * s, 4 * s, '#ffffff', 1)
      ink.fillCircle(x + e * 5 * s, y - 26 * s, 1.8 * s, NOTEBOOK.ink, 1)
    }
    // Legs: running cycle when grounded, tucked when leaping.
    if (jumping) {
      ink.stroke('run-leg1', [{ x: x - 6 * s, y: y + 16 * s }, { x: x - 16 * s, y: y + 30 * s }], line)
      ink.stroke('run-leg2', [{ x: x + 6 * s, y: y + 16 * s }, { x: x + 16 * s, y: y + 28 * s }], line)
    } else {
      const swing = Math.sin(this.runPhase) * 14 * s
      ink.stroke('run-leg1', [{ x: x - 4 * s, y: y + 16 * s }, { x: x - 6 * s + swing, y: y + 34 * s }], line)
      ink.stroke('run-leg2', [{ x: x + 4 * s, y: y + 16 * s }, { x: x + 6 * s - swing, y: y + 34 * s }], line)
    }
    // Arms.
    ink.stroke('run-arm1', [{ x, y: y - 6 * s }, { x: x - 20 * s, y: y - (jumping ? 18 : 2) * s }], line)
    ink.stroke('run-arm2', [{ x, y: y - 6 * s }, { x: x + 20 * s, y: y - (jumping ? 18 : 2) * s }], line)
  }

  /** The burned runner: bounced high, clutching its feet, over a scorch mark. */
  private drawBurnedRunner(ctx: MicroGameCtx, since: number): void {
    const { ink, services } = ctx
    const s = this.s
    const bounce = Math.sin(Math.min(1, since * 2) * Math.PI) * 200 * s
    const x = this.rx
    const y = this.pipeY - 26 * s - bounce
    const line = { color: NOTEBOOK.ink, width: 4.5 * s, passes: 2 } as const
    // Scorch mark on the pipe where they landed.
    ink.splatter('scorch', this.rx, this.pipeY, 30 * s, '#2a1a12', 8, 2.2)
    // Body curled up.
    ink.fillCircle(x, y, 20 * s, NOTEBOOK.ink, 0.95)
    ink.fillCircle(x, y - 22 * s, 14 * s, NOTEBOOK.ink, 0.95)
    // Feet held up (both legs pointing up, clutched).
    ink.stroke('burn-leg1', [{ x: x - 6 * s, y: y + 10 * s }, { x: x - 18 * s, y: y - 10 * s }], line)
    ink.stroke('burn-leg2', [{ x: x + 6 * s, y: y + 10 * s }, { x: x + 18 * s, y: y - 10 * s }], line)
    // Flames on the feet.
    for (let e = -1; e <= 1; e += 2) {
      const fr = makeRng(`burnflame${e}`, ink.boil)
      ink.fill([
        { x: x + e * 18 * s - 6 * s, y: y - 10 * s }, { x: x + e * 18 * s + range(fr, -3, 3) * s, y: y - 28 * s },
        { x: x + e * 18 * s + 6 * s, y: y - 10 * s }
      ], HIGHLIGHT.orange, 0.8)
    }
    // Pain lines + "!!!"
    ink.actionLines('painlines', x, y, 26 * s, 46 * s, 6, NOTEBOOK.markerRed)
    inkText(ink, 'burn-ow', services.t('game.shadow.burn'), x, y - 46 * s, 30 * s, {
      align: 'center', baseline: 'middle', color: NOTEBOOK.markerRed, width: 4 * s, tilt: 0.12, halo: 0.2
    })
  }

  private drawPhew(ctx: MicroGameCtx): void {
    const { ink, services } = ctx
    const s = this.s
    const pop = Math.min(1, this.phewAt / 0.1)
    inkText(ink, 'phew', services.t('game.shadow.phew'), this.rx, this.pipeY - 80 * s, 26 * s * pop, {
      align: 'center', baseline: 'middle', color: '#2a6ad8',
      width: 3.4 * s, tilt: 0.06, halo: 0.2,
      alpha: Math.max(0, 1 - Math.max(0, (this.phewAt - 0.3) / 0.2))
    })
  }

  private drawTally(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    const st = ink.stage
    for (let i = 0; i < JUMPS_TO_WIN; i++) {
      const cx = st.cx + (i - 1) * 44 * s
      const cy = st.y + st.h * 0.06
      const done = i < this.jumps
      ink.circle(`sjtally${i}`, cx, cy, 12 * s, {
        color: done ? HIGHLIGHT.cyan : NOTEBOOK.inkSoft, width: 3.2 * s, passes: 1, alpha: done ? 1 : 0.6
      })
      if (done) ink.fillCircle(cx, cy, 7 * s, HIGHLIGHT.cyan, 0.85)
    }
  }

  debug() {
    return {
      jumps: this.jumps,
      standing: this.jump < 0,
      nextX: Math.round(this.nextShadow),
      pipeY: Math.round(this.pipeY),
      hot: this.jump < 0 && isHot(this.ring)
    }
  }
}

export const shadowJump = (): MicroGame => new ShadowJump()
