// ─── Micro-game: Thermometer Tap — "COOL IT!" ──────────────────────────────
//
// vision-board-minigames §7. Heat-debt theme. A giant lab thermometer runs up
// the page, its neon-orange mercury climbing toward a BOILING POINT line at the
// top. Three neon-blue ice cubes sit along the side, each with a contracting
// ring. Tap them IN SEQUENCE as their rings align to drop ice into the meter
// and force the heat back down. Cool all three before it boils.
//
// Two failure modes: the mercury reaching the boiling line (the glass shatters)
// or the clock running out (the core loop's timeout). Both are losses. The
// mercury climbs on its own the whole time, so dawdling costs.
//
// One active ice cube at a time enforces the "in sequence" of the spec — the
// next cube only lights once the current one is dropped.

import type { MicroGame, MicroGameCtx } from '../types'
import { NOTEBOOK, HIGHLIGHT } from '@/use/ink/palette'
import { mulberry32, range, makeRng } from '@/use/ink/rng'
import { iceCrackle, glassShatter, penClick } from '@/use/ink/useInkAudio'
import { inkText } from '@/use/ink/strokeFont'
import { type Ring, makeRing, stepRing, isHot, drawRing } from '../ring'
import type { InkRenderer, Pt } from '@/use/ink/inkRenderer'

const CUBES = 3

class ThermometerTap implements MicroGame {
  readonly id = 'thermometer'
  readonly verbKey = 'game.thermometer.verb'
  readonly hintKey = 'game.thermometer.hint'
  readonly baseDuration = 7

  private rng: () => number = Math.random
  private s = 1
  /** Thermometer geometry, page units. Tube runs from bulb (bottom) up. */
  private tx = 0
  private tubeTop = 0
  private tubeBottom = 0
  private tubeW = 0
  private bulbR = 0
  /** Mercury level 0..1 (0 = bulb, 1 = boiling line). */
  private mercury = 0
  /** How fast it rises per second. */
  private riseRate = 0.13
  private cubes: { ring: Ring; used: boolean; y: number; side: number }[] = []
  private active = 0
  private done = 0
  /** Blue cool-wash flourish: seconds since last successful drop. */
  private coolAt = 99
  private shattered = false
  private shatterAt = 0
  private won = false

  init(ctx: MicroGameCtx, seed: number): void {
    const { ink } = ctx
    const st = ink.stage
    this.rng = mulberry32(seed)
    this.s = st.w * 0.0016
    this.mercury = 0.16
    this.done = 0
    this.active = 0
    this.coolAt = 99
    this.shattered = false
    this.won = false

    this.tx = st.cx
    this.tubeTop = st.y + st.h * 0.12
    this.tubeBottom = st.y + st.h * 0.8
    this.tubeW = st.w * 0.11
    this.bulbR = this.tubeW * 1.5

    // Ice cubes staggered up the tube, alternating sides.
    this.cubes = []
    for (let i = 0; i < CUBES; i++) {
      const f = (i + 0.5) / CUBES
      this.cubes.push({
        ring: makeRing(i, this.rng),
        used: false,
        y: this.tubeBottom - f * (this.tubeBottom - this.tubeTop),
        side: i % 2 === 0 ? -1 : 1
      })
    }
  }

  private cubePos(i: number): Pt {
    const c = this.cubes[i]!
    return { x: this.tx + c.side * (this.tubeW * 0.5 + 66 * this.s), y: c.y }
  }

  update(ctx: MicroGameCtx, dt: number) {
    const { pointer, services } = ctx
    if (this.coolAt < 90) this.coolAt += dt
    if (this.shattered) { this.shatterAt += dt; return undefined }
    if (this.won) return undefined

    // Mercury climbs; each drop below has already pushed it down.
    this.mercury = Math.min(1.2, this.mercury + this.riseRate * dt)
    if (this.mercury >= 1) {
      this.shattered = true
      this.shatterAt = 0
      glassShatter()
      services.shake('rip')
      services.impactFrame(3)
      return 'lost'
    }

    // Only the active cube's ring runs.
    if (this.active < CUBES) stepRing(this.cubes[this.active]!.ring, dt)

    if (pointer.pressed && this.active < CUBES) {
      const p = this.cubePos(this.active)
      const c = this.cubes[this.active]!
      const d = Math.hypot(pointer.x - p.x, pointer.y - p.y)
      const hitR = 76 * this.s
      if (d < hitR) {
        if (isHot(c.ring)) {
          c.used = true
          this.done++
          this.coolAt = 0
          // Drop the meter — a big cooling gulp.
          this.mercury = Math.max(0.08, this.mercury - 0.26)
          iceCrackle()
          services.shake('snap')
          services.impactFrame(1)
          this.active++
          if (this.done >= CUBES) { this.won = true; return 'won' }
        } else {
          // Mistimed — the cube shrugs it off; ring keeps cycling.
          penClick()
          services.shake('tick')
        }
      }
    }
    return undefined
  }

  draw(ctx: MicroGameCtx): void {
    this.drawCoolWash(ctx)
    this.drawThermometer(ctx)
    this.drawCubes(ctx)
    this.drawTally(ctx)
  }

  drawOutcome(ctx: MicroGameCtx, outcome: 'won' | 'lost', since: number): void {
    if (outcome === 'won') {
      this.drawCoolWash(ctx, true)
      this.drawThermometer(ctx)
    } else if (this.shattered) {
      this.drawShatter(ctx, this.shatterAt)
    } else {
      this.drawThermometer(ctx)
    }
  }

  private drawThermometer(ctx: MicroGameCtx): void {
    const { ink, t } = ctx
    const s = this.s
    const w = this.tubeW
    const x = this.tx
    // Glass tube (rounded top).
    ink.roundRect('thermo-tube', x - w / 2, this.tubeTop, w, this.tubeBottom - this.tubeTop, w / 2, {
      color: NOTEBOOK.ink, width: 4 * s, passes: 2, bleed: true
    })
    // Bulb.
    ink.circle('thermo-bulb', x, this.tubeBottom + this.bulbR * 0.6, this.bulbR, {
      color: NOTEBOOK.ink, width: 4 * s, passes: 2, bleed: true
    })

    // Mercury: from the bulb up to the current level, neon-orange, faintly
    // pulsing as it nears boiling.
    const level = this.tubeBottom - this.mercury * (this.tubeBottom - this.tubeTop)
    const danger = Math.max(0, (this.mercury - 0.6) / 0.4)
    const hot = 1 + Math.sin(t * (8 + danger * 20)) * 0.05 * danger
    ink.ctx.save()
    ink.ctx.beginPath()
    ink.ctx.rect(x - w / 2, level, w, this.tubeBottom - level + 4 * s)
    ink.ctx.clip()
    ink.fill([
      { x: x - w / 2, y: level }, { x: x + w / 2, y: level },
      { x: x + w / 2, y: this.tubeBottom + 10 * s }, { x: x - w / 2, y: this.tubeBottom + 10 * s }
    ], danger > 0.4 ? '#ff5a1a' : HIGHLIGHT.orange, 0.85 * hot)
    ink.ctx.restore()
    // Mercury in the bulb.
    ink.fillCircle(x, this.tubeBottom + this.bulbR * 0.6, this.bulbR * 0.82, danger > 0.4 ? '#ff5a1a' : HIGHLIGHT.orange, 0.85)

    // Scale ticks.
    for (let i = 1; i < 10; i++) {
      const ty = this.tubeBottom - (i / 10) * (this.tubeBottom - this.tubeTop)
      const long = i % 2 === 0
      ink.line(`thermo-tick${i}`, x + w / 2, ty, x + w / 2 + (long ? 18 : 10) * s, ty, {
        color: NOTEBOOK.inkSoft, width: 2 * s, passes: 1, alpha: 0.6
      })
    }
    // BOILING POINT line at the top.
    ink.line('thermo-boil', x - w * 1.2, this.tubeTop + 6 * s, x + w * 1.2, this.tubeTop + 6 * s, {
      color: NOTEBOOK.markerRed, width: 3.4 * s, passes: 2, rough: 2
    })
    inkText(ink, 'thermo-boillabel', ctx.services.t('game.thermometer.boiling'), x, this.tubeTop - 22 * s, 26 * s, {
      align: 'center', baseline: 'middle', color: NOTEBOOK.markerRed, width: 3.4 * s, tilt: 0.04, halo: 0.18
    })
  }

  private drawCubes(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    for (let i = 0; i < CUBES; i++) {
      const c = this.cubes[i]!
      const p = this.cubePos(i)
      if (c.used) continue
      const isActive = i === this.active
      // The cube: a neon-blue iso box.
      const r = 26 * s
      ink.ctx.save()
      ink.ctx.globalAlpha = isActive ? 1 : 0.4
      ink.fill([
        { x: p.x - r, y: p.y - r * 0.5 }, { x: p.x, y: p.y - r },
        { x: p.x + r, y: p.y - r * 0.5 }, { x: p.x + r, y: p.y + r * 0.5 },
        { x: p.x, y: p.y + r }, { x: p.x - r, y: p.y + r * 0.5 }
      ], '#bfe4ff', 0.85)
      ink.shape(`cube${i}`, [
        { x: p.x - r, y: p.y - r * 0.5 }, { x: p.x, y: p.y - r },
        { x: p.x + r, y: p.y - r * 0.5 }, { x: p.x + r, y: p.y + r * 0.5 },
        { x: p.x, y: p.y + r }, { x: p.x - r, y: p.y + r * 0.5 }
      ], { color: '#2a6ad8', width: 3 * s, passes: 2 })
      // Top facet lines to make it read as 3D ice.
      ink.line(`cube${i}f1`, p.x - r, p.y - r * 0.5, p.x, p.y, { color: '#2a6ad8', width: 2 * s, passes: 1, alpha: 0.6 })
      ink.line(`cube${i}f2`, p.x + r, p.y - r * 0.5, p.x, p.y, { color: '#2a6ad8', width: 2 * s, passes: 1, alpha: 0.6 })
      ink.line(`cube${i}f3`, p.x, p.y, p.x, p.y + r, { color: '#2a6ad8', width: 2 * s, passes: 1, alpha: 0.6 })
      ink.ctx.restore()
      // Ring only on the active cube.
      if (isActive) {
        drawRing(ink, `thermring${i}`, p.x, p.y, r * 1.1, c.ring, {
          cool: 'cyan', hot: 'yellow', reach: 80 * s, width: 5 * s
        })
      }
    }
  }

  /** A blue wash sweeping down the meter after a successful drop. */
  private drawCoolWash(ctx: MicroGameCtx, full = false): void {
    const { ink } = ctx
    if (!full && this.coolAt > 0.6) return
    const st = ink.stage
    const p = full ? 1 : Math.min(1, this.coolAt / 0.5)
    const alpha = full ? 0.2 : (1 - p) * 0.3
    ink.ctx.save()
    ink.ctx.globalCompositeOperation = 'multiply'
    ink.ctx.globalAlpha = alpha
    ink.ctx.fillStyle = HIGHLIGHT.cyan
    ink.ctx.fillRect(st.x, st.y, st.w, st.h * (0.2 + p * 0.8))
    ink.ctx.restore()
  }

  private drawShatter(ctx: MicroGameCtx, since: number): void {
    const { ink } = ctx
    const s = this.s
    const grow = Math.min(1, since * 2)
    const rng = makeRng('shatter', 0)
    // Shards flying out from the tube.
    for (let i = 0; i < 22; i++) {
      const a = range(rng, 0, Math.PI * 2)
      const d = grow * range(rng, 40, 320) * s
      const sx = this.tx + Math.cos(a) * d
      const sy = (this.tubeBottom + this.tubeTop) / 2 + Math.sin(a) * d
      const sz = range(rng, 6, 16) * s
      ink.shape(`shard${i}`, [
        { x: sx, y: sy - sz }, { x: sx + sz * 0.7, y: sy }, { x: sx - sz * 0.4, y: sy + sz }
      ], { color: '#2a6ad8', width: 2.4 * s, passes: 1, alpha: Math.max(0, 1 - since) })
    }
    // A splash of spilled orange mercury.
    ink.splatter('mercspill', this.tx, this.tubeBottom, 40 * s, '#ff5a1a', 14, 3)
  }

  private drawTally(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    const st = ink.stage
    for (let i = 0; i < CUBES; i++) {
      const cx = st.x + st.w * 0.12 + i * 40 * s
      const cy = st.y + st.h * 0.08
      const done = i < this.done
      ink.circle(`ttally${i}`, cx, cy, 12 * s, {
        color: done ? HIGHLIGHT.cyan : NOTEBOOK.inkSoft, width: 3.2 * s, passes: 1, alpha: done ? 1 : 0.6
      })
      if (done) ink.fillCircle(cx, cy, 7 * s, HIGHLIGHT.cyan, 0.85)
    }
  }

  debug() {
    const p = this.active < CUBES ? this.cubePos(this.active) : { x: 0, y: 0 }
    return {
      done: this.done,
      active: this.active,
      mercury: +this.mercury.toFixed(2),
      cubeX: Math.round(p.x),
      cubeY: Math.round(p.y),
      hot: this.active < CUBES ? isHot(this.cubes[this.active]!.ring) : false
    }
  }
}

export const thermometerTap = (): MicroGame => new ThermometerTap()
