// ─── Micro-game: Fan the Flame — "FAN!" ────────────────────────────────────
//
// vision-board-minigames §9. Heat-debt theme. A sleepy doodle naps on a beach
// towel while an aggressive sun in the corner sweats neon-orange heat waves
// down, filling a Heat Stress bar. The cursor is a giant paper fan. Three
// rhythmic ring targets float in front of the sleeper; tap them in rhythm to
// swing the fan and blow the heat waves back off the page.
//
// The stress bar rises the whole time; each fanned target knocks it down and
// pushes the heat back. Clear the three targets (cool the sleeper) before the
// bar fills. Let the bar fill and the sleeper overheats — a loss.

import type { MicroGame, MicroGameCtx } from '../types'
import { NOTEBOOK, HIGHLIGHT } from '@/use/ink/palette'
import { mulberry32, range, makeRng } from '@/use/ink/rng'
import { gust, penClick } from '@/use/ink/useInkAudio'
import { inkText } from '@/use/ink/strokeFont'
import { type Ring, makeRing, stepRing, isHot, drawRing } from '../ring'
import type { InkRenderer, Pt } from '@/use/ink/inkRenderer'

const TARGETS = 3

interface Target {
  x: number
  y: number
  ring: Ring
  done: boolean
}

class FanFlame implements MicroGame {
  readonly id = 'fan'
  readonly verbKey = 'game.fan.verb'
  readonly hintKey = 'game.fan.hint'
  readonly baseDuration = 6

  private rng: () => number = Math.random
  private s = 1
  private targets: Target[] = []
  private cleared = 0
  /** Heat stress 0..1. */
  private stress = 0
  private riseRate = 0.14
  /** Fan swing animation: seconds since last fan, and its direction. */
  private fanAt = 99
  private fanDir = 1
  /** Sun shocked-face timer. */
  private sunShockAt = 99
  /** Pointer position for the fan cursor. */
  private px = 0
  private py = 0
  private won = false
  private overheated = false

  init(ctx: MicroGameCtx, seed: number): void {
    const { ink } = ctx
    const st = ink.stage
    this.rng = mulberry32(seed)
    this.s = st.w * 0.0016
    this.cleared = 0
    this.stress = 0.14
    this.fanAt = 99
    this.sunShockAt = 99
    this.won = false
    this.overheated = false
    this.px = st.cx
    this.py = st.cy

    // Three targets in the air above the sleeper, spread out.
    this.targets = []
    for (let i = 0; i < TARGETS; i++) {
      const f = i / (TARGETS - 1)
      this.targets.push({
        x: st.cx + (f - 0.5) * st.w * 0.5,
        y: st.y + st.h * (0.4 - (i % 2) * 0.12),
        ring: makeRing(i, this.rng),
        done: false
      })
    }
  }

  update(ctx: MicroGameCtx, dt: number) {
    const { pointer, services } = ctx
    if (this.fanAt < 90) this.fanAt += dt
    if (this.sunShockAt < 90) this.sunShockAt += dt
    if (pointer.seen) { this.px = pointer.x; this.py = pointer.y }
    if (this.won || this.overheated) return undefined

    // The sun's heat keeps filling the stress bar.
    this.stress = Math.min(1.2, this.stress + this.riseRate * dt)
    if (this.stress >= 1) {
      this.overheated = true
      services.shake('rip')
      return 'lost'
    }

    for (const tg of this.targets) if (!tg.done) stepRing(tg.ring, dt)

    if (pointer.pressed) {
      const hitR = 78 * this.s
      let best: Target | null = null
      let bestD = Infinity
      for (const tg of this.targets) {
        if (tg.done) continue
        const d = Math.hypot(pointer.x - tg.x, pointer.y - tg.y)
        if (d < hitR && d < bestD) { bestD = d; best = tg }
      }
      if (best) {
        if (isHot(best.ring)) {
          best.done = true
          this.cleared++
          this.stress = Math.max(0.06, this.stress - 0.3)
          this.fanAt = 0
          this.fanDir = -this.fanDir
          this.sunShockAt = 0
          gust(0.8)
          services.shake('snap', 0.7)
          if (this.cleared >= TARGETS) { this.won = true; return 'won' }
        } else {
          penClick()
          services.shake('tick')
        }
      }
    }
    return undefined
  }

  draw(ctx: MicroGameCtx): void {
    this.drawSky(ctx)
    this.drawSun(ctx)
    this.drawHeatWaves(ctx)
    this.drawSleeper(ctx)
    this.drawTargets(ctx)
    this.drawWindLines(ctx)
    this.drawFan(ctx)
    this.drawStressBar(ctx)
  }

  drawOutcome(ctx: MicroGameCtx, outcome: 'won' | 'lost', since: number): void {
    this.drawSky(ctx, outcome === 'won')
    this.drawSun(ctx, outcome === 'won')
    if (outcome === 'lost') this.drawHeatWaves(ctx)
    this.drawSleeper(ctx, outcome === 'won')
    if (outcome === 'won') this.drawWindLines(ctx)
    this.drawStressBar(ctx)
  }

  private drawSky(ctx: MicroGameCtx, cooled = false): void {
    const { ink } = ctx
    const st = ink.stage
    ink.ctx.save()
    ink.ctx.globalAlpha = cooled ? 0.14 : 0.1 + this.stress * 0.14
    ink.ctx.fillStyle = cooled ? '#bfe4ff' : '#ffd9a0'
    ink.ctx.fillRect(st.x, st.y, st.w, st.h)
    ink.ctx.restore()
  }

  /** The aggressive sun in a corner, with a face + rays, dripping sweat. */
  private drawSun(ctx: MicroGameCtx, cooled = false): void {
    const { ink, t } = ctx
    const st = ink.stage
    const s = this.s
    const sx = st.x + st.w * 0.14
    const sy = st.y + st.h * 0.12
    const r = 48 * s
    // Rays.
    ink.actionLines('sunrays', sx, sy, r * 1.1, r * (1.7 + Math.sin(t * 4) * 0.1), 12, HIGHLIGHT.orange)
    ink.fillCircle(sx, sy, r, HIGHLIGHT.orange, cooled ? 0.5 : 0.9)
    ink.circle('sun', sx, sy, r, { color: '#e07a1a', width: 3.4 * s, passes: 2 })
    // Face: shocked when just fanned, smug/mean otherwise.
    const shocked = this.sunShockAt < 0.6 || cooled
    for (let e = -1; e <= 1; e += 2) {
      if (shocked) ink.circle(`suneye${e}`, sx + e * 16 * s, sy - 6 * s, 7 * s, { color: NOTEBOOK.ink, width: 2.6 * s, passes: 1 })
      else {
        // Angry slanted brow-eye.
        ink.stroke(`suneye${e}`, [
          { x: sx + e * 8 * s, y: sy - 14 * s }, { x: sx + e * 22 * s, y: sy - 4 * s }
        ], { color: NOTEBOOK.ink, width: 3.2 * s, passes: 1 })
        ink.fillCircle(sx + e * 15 * s, sy - 2 * s, 4 * s, NOTEBOOK.ink)
      }
    }
    if (shocked) {
      ink.circle('sunmouth', sx, sy + 18 * s, 8 * s, { color: NOTEBOOK.ink, width: 2.6 * s, passes: 1 })
    } else {
      ink.stroke('sunmouth', [
        { x: sx - 14 * s, y: sy + 22 * s }, { x: sx, y: sy + 14 * s }, { x: sx + 14 * s, y: sy + 22 * s }
      ], { color: NOTEBOOK.ink, width: 2.8 * s, passes: 1 })
    }
    // A bead of sweat.
    ink.fill([
      { x: sx + r * 0.7, y: sy + r * 0.5 }, { x: sx + r * 0.7 - 5 * s, y: sy + r * 0.5 + 14 * s },
      { x: sx + r * 0.7 + 5 * s, y: sy + r * 0.5 + 14 * s }
    ], HIGHLIGHT.cyan, 0.8)
  }

  /** Neon-orange heat waves raining down from the sun onto the sleeper. */
  private drawHeatWaves(ctx: MicroGameCtx): void {
    const { ink, t } = ctx
    const st = ink.stage
    const s = this.s
    const sx = st.x + st.w * 0.14
    const sy = st.y + st.h * 0.12
    const tx = st.cx
    const ty = st.y + st.h * 0.72
    const n = 5
    for (let i = 0; i < n; i++) {
      const f = i / n
      const cx = sx + (tx - sx) * f
      const cy = sy + (ty - sy) * f
      const pts: Pt[] = []
      for (let k = 0; k <= 8; k++) {
        const kf = k / 8
        pts.push({
          x: cx - 40 * s + kf * 80 * s,
          y: cy + Math.sin(kf * 8 + t * 5 + i) * 6 * s
        })
      }
      ink.stroke(`heatw${i}`, pts, {
        color: HIGHLIGHT.orange, width: 3 * s, passes: 1, alpha: 0.25 + this.stress * 0.2, rough: 1.5
      })
    }
  }

  /** The sleepy doodle on a beach towel. */
  private drawSleeper(ctx: MicroGameCtx, cooled = false): void {
    const { ink, t } = ctx
    const st = ink.stage
    const s = this.s
    const cx = st.cx
    const cy = st.y + st.h * 0.76
    // Towel.
    ink.fill([
      { x: cx - 150 * s, y: cy + 10 * s }, { x: cx + 150 * s, y: cy + 10 * s },
      { x: cx + 160 * s, y: cy + 44 * s }, { x: cx - 160 * s, y: cy + 44 * s }
    ], '#e88aa0', 0.7)
    for (let i = -2; i <= 2; i++) {
      ink.line(`towel${i}`, cx + i * 50 * s, cy + 10 * s, cx + i * 50 * s, cy + 44 * s, {
        color: '#c85a75', width: 3 * s, passes: 1, alpha: 0.6
      })
    }
    // Body lying down.
    ink.stroke('sleeper-body', [
      { x: cx - 120 * s, y: cy }, { x: cx + 90 * s, y: cy + 4 * s }
    ], { color: NOTEBOOK.ink, width: 6 * s, passes: 2 })
    // Head (resting), with closed sleepy eyes.
    const hx = cx - 130 * s
    ink.fillCircle(hx, cy - 14 * s, 26 * s, '#f2ead8', 0.95)
    ink.circle('sleeper-head', hx, cy - 14 * s, 26 * s, { color: NOTEBOOK.ink, width: 4 * s, passes: 2 })
    for (let e = -1; e <= 1; e += 2) {
      ink.stroke(`sleeper-eye${e}`, [
        { x: hx + e * 4 * s - 8 * s, y: cy - 16 * s }, { x: hx + e * 4 * s + 8 * s, y: cy - 14 * s }
      ], { color: NOTEBOOK.ink, width: 2.6 * s, passes: 1 })
    }
    // A snore "Z" or, when cooled, a content smile. Sweat drops if hot.
    if (cooled) {
      ink.stroke('sleeper-smile', [
        { x: hx - 8 * s, y: cy - 2 * s }, { x: hx, y: cy + 4 * s }, { x: hx + 8 * s, y: cy - 2 * s }
      ], { color: NOTEBOOK.ink, width: 2.6 * s, passes: 1 })
    } else {
      inkText(ink, 'snore-z', 'Z', hx + 34 * s, cy - 40 * s, 26 * s, {
        align: 'center', baseline: 'middle', color: NOTEBOOK.inkSoft, width: 3 * s, tilt: 0.1
      })
      // Sweat beads when hot.
      if (this.stress > 0.4) {
        ink.fill([
          { x: hx + 20 * s, y: cy - 26 * s }, { x: hx + 16 * s, y: cy - 14 * s }, { x: hx + 24 * s, y: cy - 14 * s }
        ], HIGHLIGHT.cyan, 0.8)
      }
    }
  }

  private drawTargets(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    for (let i = 0; i < this.targets.length; i++) {
      const tg = this.targets[i]!
      if (tg.done) continue
      // A little swirl icon in the ring's centre — "fan here".
      const rng = makeRng(`fantgt${i}`, ink.boil)
      const pts: Pt[] = []
      for (let k = 0; k <= 10; k++) {
        const a = (k / 10) * Math.PI * 2.4
        const rr = (6 + k * 1.6) * s
        pts.push({ x: tg.x + Math.cos(a) * rr, y: tg.y + Math.sin(a) * rr })
      }
      ink.stroke(`fantwirl${i}`, pts, { color: HIGHLIGHT.cyan, width: 3 * s, passes: 1, alpha: 0.7 })
      drawRing(ink, `fanring${i}`, tg.x, tg.y, 22 * s, tg.ring, {
        cool: 'cyan', hot: 'yellow', reach: 78 * s, width: 5 * s
      })
    }
  }

  /** Cool blue wind lines sweeping across after a fan stroke. */
  private drawWindLines(ctx: MicroGameCtx): void {
    const { ink } = ctx
    if (this.fanAt > 0.6) return
    const st = ink.stage
    const s = this.s
    const p = Math.min(1, this.fanAt / 0.5)
    const alpha = (1 - p) * 0.8
    const rng = makeRng('fanwind', ink.boil)
    for (let i = 0; i < 6; i++) {
      const y = st.y + st.h * (0.2 + i * 0.1) + range(rng, -10, 10) * s
      const x0 = st.x + p * st.w * 0.5
      const pts: Pt[] = []
      for (let k = 0; k <= 6; k++) {
        const kf = k / 6
        pts.push({ x: x0 + kf * st.w * 0.5 * this.fanDir + (this.fanDir < 0 ? st.w * 0.5 : 0), y: y + Math.sin(kf * 5 + i) * 8 * s })
      }
      ink.stroke(`fanwindl${i}`, pts, { color: HIGHLIGHT.cyan, width: 4 * s, passes: 1, alpha, rough: 2 })
    }
  }

  /** The paper-fan cursor. */
  private drawFan(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    // Swing angle animates briefly after a fan.
    const swing = this.fanAt < 0.3 ? Math.sin(this.fanAt / 0.3 * Math.PI) * 0.5 * this.fanDir : 0
    ink.transformed(this.px, this.py, swing, 1, () => {
      // A folded paper fan: a wedge of ribs from a pivot.
      const ribs = 6
      const rad = 66 * s
      const spread = 1.2
      for (let i = 0; i <= ribs; i++) {
        const a = -spread / 2 + (i / ribs) * spread - Math.PI / 2
        ink.stroke(`fanrib${i}`, [
          { x: 0, y: 0 }, { x: Math.cos(a) * rad, y: Math.sin(a) * rad }
        ], { color: NOTEBOOK.ink, width: 3 * s, passes: 1 })
      }
      // The paper arc.
      const pts: Pt[] = []
      for (let i = 0; i <= ribs; i++) {
        const a = -spread / 2 + (i / ribs) * spread - Math.PI / 2
        pts.push({ x: Math.cos(a) * rad, y: Math.sin(a) * rad })
      }
      ink.fill([{ x: 0, y: 0 }, ...pts], '#eae0c8', 0.85)
      ink.stroke('fanarc', pts, { color: NOTEBOOK.ink, width: 3.4 * s, passes: 2 })
      // Pivot.
      ink.fillCircle(0, 0, 5 * s, NOTEBOOK.ink)
    })
  }

  private drawStressBar(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    const st = ink.stage
    const bw = st.w * 0.5
    const bx = st.cx - bw / 2
    const by = st.y + st.h * 0.06
    const bh = st.h * 0.028
    inkText(ink, 'stress-label', ctx.services.t('game.fan.stress'), bx - 10 * s, by + bh / 2, 20 * s, {
      align: 'right', baseline: 'middle', color: NOTEBOOK.inkSoft, width: 2.4 * s
    })
    ink.rect('stress-frame', bx, by, bw, bh, { width: 3 * s, passes: 1 })
    const p = Math.min(1, this.stress)
    if (p > 0.01) {
      ink.ctx.save()
      ink.ctx.beginPath()
      ink.ctx.rect(bx, by, bw * p, bh)
      ink.ctx.clip()
      ink.fill([
        { x: bx, y: by }, { x: bx + bw, y: by }, { x: bx + bw, y: by + bh }, { x: bx, y: by + bh }
      ], p > 0.7 ? '#ff5a1a' : HIGHLIGHT.orange, 0.9)
      ink.ctx.restore()
    }
  }

  debug() {
    return {
      cleared: this.cleared,
      stress: +this.stress.toFixed(2),
      targets: this.targets.map((t) => ({ x: Math.round(t.x), y: Math.round(t.y), done: t.done, hot: isHot(t.ring) }))
    }
  }
}

export const fanFlame = (): MicroGame => new FanFlame()
