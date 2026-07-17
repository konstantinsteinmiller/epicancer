// ─── Micro-game: Static Cat — "PET!" ───────────────────────────────────────
//
// vision-board-minigames §1. A grumpy long-haired cat sits on the notebook
// lines, crackling with a jagged neon-yellow static aura. Three sparks pop up
// in its fur, each with a contracting ring. Click each as its ring collapses.
//
// The spec says outright to copy the mosquito game's simplicity, so the timing
// model here is deliberately identical — same ring, same window, same
// recycling-on-miss forgiveness (see mosquitoSwat for why a mistimed tap must
// not end the round). What differs is everything around it: the target is a
// cat who reacts, and the payoff is affection rather than a kill.

import type { MicroGame, MicroGameCtx } from '../types'
import { NOTEBOOK, HIGHLIGHT } from '@/use/ink/palette'
import { mulberry32, range, makeRng } from '@/use/ink/rng'
import { zap, penClick, chime } from '@/use/ink/useInkAudio'
import { inkText } from '@/use/ink/strokeFont'
import type { Pt } from '@/use/ink/inkRenderer'

const HIT_WINDOW = 0.16
const COUNT = 3

interface Spark {
  /** Position on the cat's back, in page units. */
  x: number
  y: number
  ring: number
  speed: number
  dead: boolean
  deadAt: number
  phase: number
}

class StaticCat implements MicroGame {
  readonly id = 'cat'
  readonly verbKey = 'game.cat.verb'
  readonly hintKey = 'game.cat.hint'
  readonly baseDuration = 5

  private sparks: Spark[] = []
  private rng: () => number = Math.random
  private cx = 0
  private cy = 0
  /** Body module — everything is proportioned off this. */
  private s = 1
  /** 0..1 how puffed the fur is. Spikes on every zap and settles back. */
  private puff = 0
  /** Seconds since the cat was fully pacified, or -1. */
  private happyAt = -1

  init(ctx: MicroGameCtx, seed: number): void {
    const { ink } = ctx
    const st = ink.stage
    this.rng = mulberry32(seed)
    this.puff = 0
    this.happyAt = -1

    this.cx = st.cx
    this.cy = st.y + st.h * 0.58
    this.s = st.w * 0.0016

    // Sparks sit along the cat's back, spaced so no two taps are ambiguous.
    this.sparks = []
    for (let i = 0; i < COUNT; i++) {
      const f = i / (COUNT - 1)
      this.sparks.push({
        x: this.cx + (f - 0.5) * 170 * this.s + range(this.rng, -8, 8) * this.s,
        y: this.cy - 74 * this.s + Math.sin(f * Math.PI) * -18 * this.s
          + range(this.rng, -6, 6) * this.s,
        ring: 1,
        // Staggered so the three never collapse together — one finger, one tap.
        speed: 0.44 + i * 0.1 + range(this.rng, -0.03, 0.03),
        dead: false,
        deadAt: 0,
        phase: range(this.rng, 0, Math.PI * 2)
      })
    }
  }

  update(ctx: MicroGameCtx, dt: number) {
    const { pointer, services } = ctx

    this.puff = Math.max(0, this.puff - dt * 2.2)
    if (this.happyAt >= 0) this.happyAt += dt

    for (const sp of this.sparks) {
      if (sp.dead) { sp.deadAt += dt; continue }
      sp.ring -= sp.speed * dt
      // Recycle rather than vanish — a dead target the player can never clear
      // would be theft on a 5-second clock.
      if (sp.ring <= -HIT_WINDOW) sp.ring = 1
    }

    if (pointer.pressed) {
      const hitR = 78 * this.s
      let best: Spark | null = null
      let bestD = Infinity
      for (const sp of this.sparks) {
        if (sp.dead) continue
        const d = Math.hypot(pointer.x - sp.x, pointer.y - sp.y)
        if (d < hitR && d < bestD) { bestD = d; best = sp }
      }
      if (best) {
        if (Math.abs(best.ring) <= HIT_WINDOW) {
          best.dead = true
          best.deadAt = 0
          this.puff = 1
          zap()
          services.shake('snap')
          services.impactFrame(2)
        } else {
          // Mistimed: the cat is unimpressed, the round continues.
          penClick()
          services.shake('tick')
        }
      }
    }

    if (this.sparks.every((sp) => sp.dead)) {
      if (this.happyAt < 0) {
        this.happyAt = 0
        chime(2)
      }
      return 'won'
    }
    return undefined
  }

  draw(ctx: MicroGameCtx): void {
    this.drawAura(ctx)
    this.drawCat(ctx)
    for (let i = 0; i < this.sparks.length; i++) {
      const sp = this.sparks[i]!
      if (!sp.dead) this.drawSpark(ctx, sp, i)
      else this.drawZapBurst(ctx, sp, i)
    }
  }

  drawOutcome(ctx: MicroGameCtx, outcome: 'won' | 'lost', since: number): void {
    const { ink } = ctx
    if (outcome === 'won') {
      // "The cat purrs and melts into a happy, flat puddle of ink with heart
      // doodles floating up."
      const melt = Math.min(1, since * 1.3)
      this.drawCat(ctx, melt)
      this.drawHearts(ctx, since)
    } else {
      // Still charged, still furious.
      this.drawAura(ctx)
      this.drawCat(ctx)
      for (let i = 0; i < this.sparks.length; i++) {
        const sp = this.sparks[i]!
        if (!sp.dead) this.drawSpark(ctx, sp, i)
      }
    }
  }

  /** The jagged neon-yellow static field around the whole animal. */
  private drawAura(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const rng = makeRng('cat-aura', ink.boil)
    const s = this.s
    const pts: Pt[] = []
    const steps = 26
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2
      // Sawtooth radius — a static field is spiky, not a soft glow.
      const spike = i % 2 === 0 ? range(rng, 1.12, 1.4) : range(rng, 0.82, 0.95)
      const rx = 155 * s * spike * (1 + this.puff * 0.14)
      const ry = 96 * s * spike * (1 + this.puff * 0.2)
      pts.push({ x: this.cx + Math.cos(a) * rx, y: this.cy - 30 * s + Math.sin(a) * ry })
    }
    ink.ctx.save()
    ink.ctx.globalCompositeOperation = 'multiply'
    ink.fill(pts, HIGHLIGHT.yellow, 0.22 + this.puff * 0.2)
    ink.ctx.restore()
    ink.stroke('cat-aura', pts, {
      color: HIGHLIGHT.yellow, width: 4 * s, passes: 1, close: true, alpha: 0.8, rough: 5
    })
  }

  /**
   * The cat. `melt` 0..1 flattens it into a contented puddle for the win.
   *
   * Long-haired and grumpy: the fur is a ragged outline rather than a smooth
   * one, and the face is a scowl by default.
   */
  private drawCat(ctx: MicroGameCtx, melt = 0): void {
    const { ink, t } = ctx
    const s = this.s
    const squash = 1 - melt * 0.82
    const cy = this.cy + melt * 40 * s
    const rng = makeRng('cat-body', ink.boil)

    // ── Body: a ragged long-haired blob. ──
    const body: Pt[] = []
    const steps = 24
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2
      // The fur tufts stand on end as the static bites.
      const tuft = range(rng, 0.9, 1.1) + this.puff * range(rng, 0, 0.34)
      const rx = 118 * s * tuft * (1 + melt * 0.5)
      const ry = 62 * s * tuft * squash
      body.push({ x: this.cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry })
    }
    ink.fill(body, melt > 0.5 ? '#cfd6e0' : '#e8e4dc', 0.9)
    ink.shape('cat-body', body, { width: 4.5 * s, bleed: true })

    if (melt > 0.75) {
      // Fully melted: a flat puddle with a blissful face.
      inkText(ink, 'cat-purr', '~', this.cx, cy, 40 * s, {
        align: 'center', baseline: 'middle', color: NOTEBOOK.inkSoft, width: 5 * s
      })
      return
    }

    // ── Tail, curled and bristling. ──
    const tail: Pt[] = []
    for (let i = 0; i <= 8; i++) {
      const f = i / 8
      tail.push({
        x: this.cx + 112 * s + Math.sin(f * 3 + t * 3) * 22 * s * (1 - melt),
        y: cy + 10 * s - f * 78 * s * (1 - melt)
      })
    }
    ink.stroke('cat-tail', tail, { width: (14 + this.puff * 8) * s, passes: 2, bleed: true })

    // ── Head + ears. ──
    const hx = this.cx - 92 * s
    const hy = cy - 46 * s * (1 - melt)
    ink.fillCircle(hx, hy, 46 * s, '#e8e4dc', 1)
    ink.circle('cat-head', hx, hy, 46 * s, { width: 4.5 * s, bleed: true })
    for (let i = 0; i < 2; i++) {
      const dir = i === 0 ? -1 : 1
      // Ears flatten back when angry, prick up when happy.
      const flat = 1 - melt
      ink.shape(`cat-ear${i}`, [
        { x: hx + dir * 16 * s, y: hy - 34 * s },
        { x: hx + dir * (30 + flat * 8) * s, y: hy - (62 + flat * 10) * s },
        { x: hx + dir * 40 * s, y: hy - 26 * s }
      ], { width: 4 * s })
    }

    // ── Face: a scowl, unless we've won. ──
    const happy = melt > 0.2
    for (let i = 0; i < 2; i++) {
      const dir = i === 0 ? -1 : 1
      const ex = hx + dir * 17 * s
      const ey = hy - 6 * s
      if (happy) {
        // Blissful closed eyes: ^ ^
        ink.stroke(`cat-eye${i}`, [
          { x: ex - 9 * s, y: ey + 3 * s },
          { x: ex, y: ey - 6 * s },
          { x: ex + 9 * s, y: ey + 3 * s }
        ], { width: 3.4 * s, passes: 1 })
      } else {
        ink.fillCircle(ex, ey, 7 * s, NOTEBOOK.ink, 1)
        // Angry brow.
        ink.stroke(`cat-brow${i}`, [
          { x: ex - dir * 13 * s, y: ey - 18 * s },
          { x: ex + dir * 9 * s, y: ey - 9 * s }
        ], { width: 3.6 * s, passes: 1 })
      }
    }
    // Nose + mouth.
    ink.fillCircle(hx, hy + 14 * s, 5 * s, NOTEBOOK.markerRed, 0.9)
    ink.stroke('cat-mouth', [
      { x: hx - 12 * s, y: hy + (happy ? 26 : 24) * s },
      { x: hx, y: hy + (happy ? 32 : 20) * s },
      { x: hx + 12 * s, y: hy + (happy ? 26 : 24) * s }
    ], { width: 3.2 * s, passes: 1 })
    // Whiskers.
    for (let i = 0; i < 4; i++) {
      const dir = i < 2 ? -1 : 1
      const off = (i % 2) * 9 * s
      ink.stroke(`cat-whisk${i}`, [
        { x: hx + dir * 14 * s, y: hy + 12 * s + off },
        { x: hx + dir * 56 * s, y: hy + 4 * s + off * 1.6 }
      ], { width: 2 * s, passes: 1, alpha: 0.75 })
    }

    // ── Legs, tucked (loaf position). ──
    for (let i = 0; i < 2; i++) {
      const lx = this.cx - 30 * s + i * 66 * s
      ink.stroke(`cat-leg${i}`, [
        { x: lx, y: cy + 50 * s * squash },
        { x: lx, y: cy + 66 * s * squash }
      ], { width: 12 * s, passes: 1 })
    }
  }

  /** A spark: a mini lightning bolt with a contracting ring. */
  private drawSpark(ctx: MicroGameCtx, sp: Spark, i: number): void {
    const { ink, t } = ctx
    const s = this.s
    const hot = Math.abs(sp.ring) <= HIT_WINDOW
    const bodyR = 15 * s
    const ringR = bodyR + Math.max(0, sp.ring) * 92 * s

    ink.circle(`cat-ring${i}`, sp.x, sp.y, ringR, {
      color: hot ? HIGHLIGHT.pink : HIGHLIGHT.cyan,
      width: hot ? 9 * s : 5 * s,
      passes: hot ? 2 : 1,
      rough: 2.4,
      alpha: hot ? 1 : 0.75
    })
    if (hot) ink.highlightBlob(`cat-flare${i}`, sp.x, sp.y, bodyR * 2.4, 'pink', 0.4)

    // The bolt itself — a hand-drawn zigzag, jittering on the boil.
    const rng = makeRng(`bolt${i}`, ink.boil)
    const pts: Pt[] = []
    for (let k = 0; k <= 4; k++) {
      const f = k / 4
      pts.push({
        x: sp.x + (k % 2 === 0 ? -1 : 1) * 9 * s * range(rng, 0.7, 1.3),
        y: sp.y - 20 * s + f * 40 * s
      })
    }
    ink.stroke(`cat-bolt${i}`, pts, {
      color: NOTEBOOK.markerRed, width: 5 * s, passes: 2, bleed: true
    })
    // A crackle halo so it reads as electric even at rest.
    ink.actionLines(`cat-crackle${i}`, sp.x, sp.y, 20 * s, 30 * s + Math.sin(t * 20 + sp.phase) * 6 * s,
      5, HIGHLIGHT.yellow)
  }

  /** The kill: ZAP! and the fur blows out. */
  private drawZapBurst(ctx: MicroGameCtx, sp: Spark, i: number): void {
    const { ink, services } = ctx
    const s = this.s
    const age = sp.deadAt
    if (age > 0.5) return
    const grow = Math.min(1, age / 0.1)
    ink.actionLines(`cat-zapburst${i}`, sp.x, sp.y, 18 * s, (18 + grow * 70) * s, 9, HIGHLIGHT.yellow)
    inkText(ink, `cat-zap${i}`, services.t('game.cat.zap'), sp.x, sp.y - 44 * s, 30 * s * grow, {
      align: 'center',
      baseline: 'middle',
      color: NOTEBOOK.markerRed,
      width: 4 * s,
      rotate: -0.18,
      tilt: 0.1,
      alpha: Math.max(0, 1 - Math.max(0, (age - 0.3) / 0.2))
    })
  }

  /** Hearts floating up off the pacified cat. */
  private drawHearts(ctx: MicroGameCtx, since: number): void {
    const { ink } = ctx
    const s = this.s
    const rng = makeRng('cat-hearts', 0)
    for (let i = 0; i < 5; i++) {
      const delay = i * 0.12
      const a = since - delay
      if (a < 0) continue
      const x = this.cx + range(rng, -70, 70) * s + Math.sin(a * 3 + i) * 10 * s
      const y = this.cy - 40 * s - a * 130 * s
      const alpha = Math.max(0, 1 - a * 0.7)
      if (alpha <= 0) continue
      const r = 13 * s
      const pts: Pt[] = []
      for (let k = 0; k <= 14; k++) {
        const th = (k / 14) * Math.PI * 2
        const hx = 16 * Math.pow(Math.sin(th), 3)
        const hy = -(13 * Math.cos(th) - 5 * Math.cos(2 * th) - 2 * Math.cos(3 * th) - Math.cos(4 * th))
        pts.push({ x: x + (hx / 16) * r, y: y + (hy / 16) * r })
      }
      ink.ctx.save()
      ink.ctx.globalAlpha = alpha
      ink.fill(pts, NOTEBOOK.markerRed, 0.85)
      ink.stroke(`cat-heart${i}`, pts, {
        color: NOTEBOOK.markerRed, width: 2.4 * s, passes: 1, close: true
      })
      ink.ctx.restore()
    }
  }
}

export const staticCat = (): MicroGame => new StaticCat()
