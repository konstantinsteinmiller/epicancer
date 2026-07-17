// ─── Micro-game: Mirage Whack — "WHACK!" ───────────────────────────────────
//
// vision-board-minigames §6. Heat-shimmer theme. Three desert jerboas poke out
// of holes on the page. The heat haze blurs everything with wavy pencil lines,
// and two of the jerboas are translucent MIRAGES — only one is solid black ink.
// Contracting rings sit on all three; tap the SOLID one when its ring aligns.
// Tapping a mirage just poofs into empty ink.
//
// It's the mosquito's timing mechanic (shared `ring.ts`) with a perception
// twist: the challenge isn't only WHEN to tap, it's WHICH of the three is real
// through the shimmer. Bop three real jerboas to win.

import type { MicroGame, MicroGameCtx } from '../types'
import { NOTEBOOK, HIGHLIGHT } from '@/use/ink/palette'
import { mulberry32, range, makeRng } from '@/use/ink/rng'
import { boop, poof } from '@/use/ink/useInkAudio'
import { inkText } from '@/use/ink/strokeFont'
import { type Ring, makeRing, stepRing, isHot, drawRing, drawSparkleBurst } from '../ring'
import type { InkRenderer, Pt } from '@/use/ink/inkRenderer'

const HOLES = 3
const TO_WIN = 3

interface Hole {
  x: number
  y: number
  ring: Ring
  /** 0..1 how far the jerboa is up out of the hole. */
  up: number
  /** Bobbing phase for idle life. */
  phase: number
}

class MirageWhack implements MicroGame {
  readonly id = 'mirage'
  readonly verbKey = 'game.mirage.verb'
  readonly hintKey = 'game.mirage.hint'
  readonly baseDuration = 6

  private holes: Hole[] = []
  private rng: () => number = Math.random
  private s = 1
  /** Which hole currently holds the SOLID jerboa. */
  private solid = 0
  private bopped = 0
  /** Bop flourish: hole index + seconds since. */
  private boopHole = -1
  private boopAt = 0
  /** Miss poof: position + seconds since. */
  private poofX = 0
  private poofY = 0
  private poofAt = 99
  private won = false

  init(ctx: MicroGameCtx, seed: number): void {
    const { ink } = ctx
    const st = ink.stage
    this.rng = mulberry32(seed)
    this.s = st.w * 0.0016
    this.bopped = 0
    this.boopHole = -1
    this.poofAt = 99
    this.won = false

    // Three holes spread across the middle of the page.
    this.holes = []
    for (let i = 0; i < HOLES; i++) {
      const f = i / (HOLES - 1)
      this.holes.push({
        x: st.cx + (f - 0.5) * st.w * 0.62,
        y: st.y + st.h * (0.42 + (i % 2) * 0.22),
        ring: makeRing(i, this.rng),
        up: 0,
        phase: range(this.rng, 0, Math.PI * 2)
      })
    }
    this.solid = Math.floor(this.rng() * HOLES)
  }

  update(ctx: MicroGameCtx, dt: number) {
    const { pointer, services, t } = ctx
    if (this.poofAt < 90) this.poofAt += dt
    if (this.boopHole >= 0) this.boopAt += dt
    if (this.won) return undefined

    for (const h of this.holes) {
      stepRing(h.ring, dt)
      // Jerboas rise up and hold.
      h.up = Math.min(1, h.up + dt * 4)
      h.phase += dt * 3
    }

    if (pointer.pressed) {
      const hitR = 82 * this.s
      let best = -1
      let bestD = Infinity
      for (let i = 0; i < this.holes.length; i++) {
        const h = this.holes[i]!
        const d = Math.hypot(pointer.x - h.x, pointer.y - (h.y - this.jerboaLift(h)))
        if (d < hitR && d < bestD) { bestD = d; best = i }
      }
      if (best >= 0) {
        const h = this.holes[best]!
        if (best === this.solid && isHot(h.ring)) {
          // Bopped the real one on the beat.
          this.bopped++
          this.boopHole = best
          this.boopAt = 0
          boop()
          services.shake('snap')
          services.impactFrame(2)
          if (this.bopped >= TO_WIN) { this.won = true; return 'won' }
          // Re-seat: this hole's jerboa ducks and a NEW hole becomes solid.
          h.up = 0
          h.ring.ring = 1
          let next = Math.floor(this.rng() * HOLES)
          if (next === best) next = (next + 1) % HOLES
          this.solid = next
          // Reshuffle the ring phases so the tell isn't predictable.
          for (let i = 0; i < this.holes.length; i++) this.holes[i]!.ring = makeRing(i + this.bopped, this.rng)
        } else {
          // A mirage, or the real one off-beat: poof of empty ink.
          this.poofX = h.x
          this.poofY = h.y - this.jerboaLift(h)
          this.poofAt = 0
          poof()
          services.shake('tick')
        }
      }
    }
    return undefined
  }

  private jerboaLift(h: Hole): number {
    return h.up * 46 * this.s + Math.sin(h.phase) * 4 * this.s
  }

  draw(ctx: MicroGameCtx): void {
    this.drawGround(ctx)
    // Draw non-solid (mirage) jerboas first, then the solid on top so the real
    // one reads clearly once you've found it.
    for (let i = 0; i < this.holes.length; i++) if (i !== this.solid) this.drawHole(ctx, i)
    this.drawHole(ctx, this.solid)
    if (this.boopHole >= 0) this.drawBoop(ctx)
    if (this.poofAt < 0.5) this.drawPoof(ctx)
    this.drawShimmer(ctx)
    this.drawTally(ctx)
  }

  drawOutcome(ctx: MicroGameCtx, outcome: 'won' | 'lost', since: number): void {
    this.drawGround(ctx)
    for (let i = 0; i < this.holes.length; i++) {
      if (outcome === 'lost' || i === this.solid) this.drawHole(ctx, i)
    }
    if (outcome === 'won' && this.boopHole >= 0) this.drawBoop(ctx)
    this.drawShimmer(ctx)
  }

  private drawGround(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const st = ink.stage
    // A warm sandy wash so it reads as desert.
    ink.ctx.save()
    ink.ctx.globalAlpha = 0.16
    ink.ctx.fillStyle = '#e0c088'
    ink.ctx.fillRect(st.x, st.y, st.w, st.h)
    ink.ctx.restore()
    // A few sand dune curves + speckle.
    const rng = makeRng('mirage-sand', 0)
    for (let i = 0; i < 3; i++) {
      const y = st.y + st.h * (0.3 + i * 0.22)
      ink.stroke(`dune${i}`, [
        { x: st.x, y }, { x: st.cx, y: y - 14 * this.s }, { x: st.x + st.w, y }
      ], { color: '#b89858', width: 2.4 * this.s, passes: 1, alpha: 0.4, rough: 3 })
    }
  }

  /** A hole with its jerboa. `i === solid` draws solid ink; others are faint
   *  mirages that shimmer and wobble. */
  private drawHole(ctx: MicroGameCtx, i: number): void {
    const { ink } = ctx
    const s = this.s
    const h = this.holes[i]!
    const isSolid = i === this.solid
    // The hole: a dark ellipse in the sand.
    ink.ellipse(`hole${i}`, h.x, h.y, 56 * s, 22 * s, 0, {
      color: NOTEBOOK.ink, width: 3.5 * s, passes: 2
    })
    ink.fill([
      { x: h.x - 50 * s, y: h.y }, { x: h.x, y: h.y - 16 * s },
      { x: h.x + 50 * s, y: h.y }, { x: h.x, y: h.y + 16 * s }
    ], '#3a2e1e', 0.6)

    const lift = this.jerboaLift(h)
    const jy = h.y - lift
    // Mirages are clearly ghostly: much fainter, wobbling harder, and tinted
    // with a heat-orange shimmer so they read as illusions rather than just a
    // dimmer copy. The solid one is crisp and still — the one you can trust.
    const wobble = isSolid ? 0 : Math.sin(h.phase * 2.2 + i) * 12 * s
    const alpha = isSolid ? 1 : 0.2

    if (isSolid) {
      this.drawJerboa(ink, h.x, jy, i)
    } else {
      // A mirage: a faint, translucent jerboa plus two even-fainter copies
      // offset sideways, so it reads as a shimmering see-through double-vision
      // rather than a solid animal. Normal blend (not multiply) keeps it LIGHT
      // — a heat haze you can look through, not a dark scribble.
      const t = ctx.t
      ink.ctx.save()
      ink.ctx.globalAlpha = alpha
      this.drawJerboa(ink, h.x + wobble, jy, i)
      ink.ctx.globalAlpha = alpha * 0.5
      this.drawJerboa(ink, h.x + wobble + Math.sin(t * 4 + i) * 10 * s, jy, i)
      this.drawJerboa(ink, h.x + wobble - Math.sin(t * 4 + i) * 10 * s, jy, i)
      ink.ctx.restore()
    }

    // The ring sits on the jerboa's body.
    drawRing(ink, `mring${i}`, h.x + wobble, jy - 10 * s, 20 * s, h.ring, {
      cool: 'cyan', hot: 'yellow', reach: 84 * s, width: 5 * s
    })
  }

  /** A little desert jerboa: big round head, huge ears, tiny arms, long
   *  tufted tail, kangaroo hind feet. Cute. */
  private drawJerboa(ink: InkRenderer, x: number, y: number, i: number): void {
    const s = this.s
    const col = NOTEBOOK.ink
    const line = { color: col, width: 3.2 * s, passes: 2 } as const
    // Tail — long, curving up behind, with a dark tuft.
    ink.stroke(`jerb${i}tail`, [
      { x: x + 30 * s, y: y + 30 * s },
      { x: x + 66 * s, y: y + 10 * s },
      { x: x + 70 * s, y: y - 30 * s }
    ], { color: col, width: 3 * s, passes: 2, rough: 1.6 })
    ink.fillCircle(x + 70 * s, y - 34 * s, 8 * s, col, 0.9)
    // Body — a plump rounded blob (sampled circle so it reads soft, not boxy).
    const body: Pt[] = []
    for (let k = 0; k <= 12; k++) {
      const a = (k / 12) * Math.PI * 2
      // Slightly taller than wide, narrowing toward the head.
      body.push({ x: x + Math.cos(a) * 24 * s, y: y + 6 * s + Math.sin(a) * 30 * s })
    }
    ink.fill(body, '#f2ead8', 0.92)
    ink.shape(`jerb${i}body`, body, line)
    // Big kangaroo hind foot poking forward.
    ink.stroke(`jerb${i}foot`, [
      { x: x - 6 * s, y: y + 30 * s },
      { x: x - 26 * s, y: y + 40 * s },
      { x: x - 34 * s, y: y + 38 * s }
    ], { color: col, width: 4 * s, passes: 2 })
    // Tiny front paw.
    ink.stroke(`jerb${i}paw`, [
      { x: x + 10 * s, y: y + 6 * s }, { x: x + 18 * s, y: y + 16 * s }
    ], { color: col, width: 2.6 * s, passes: 1 })
    // Head.
    ink.fillCircle(x, y - 34 * s, 24 * s, '#f2ead8', 0.95)
    ink.circle(`jerb${i}head`, x, y - 34 * s, 24 * s, line)
    // Big ears.
    for (let e = -1; e <= 1; e += 2) {
      ink.ellipse(`jerb${i}ear${e}`, x + e * 16 * s, y - 58 * s, 8 * s, 22 * s, e * 0.3, line)
    }
    // Eyes (big and dark) + nose.
    for (let e = -1; e <= 1; e += 2) {
      ink.fillCircle(x + e * 9 * s, y - 36 * s, 5 * s, col, 0.95)
    }
    ink.fillCircle(x, y - 24 * s, 3.5 * s, NOTEBOOK.markerRed, 0.9)
    // Whiskers.
    for (let w = 0; w < 2; w++) {
      ink.stroke(`jerb${i}whisk${w}`, [
        { x: x + (w ? 6 : -6) * s, y: y - 24 * s },
        { x: x + (w ? 30 : -30) * s, y: y - (26 + w * 4) * s }
      ], { color: col, width: 1.4 * s, passes: 1, alpha: 0.7 })
    }
  }

  /** BOOP! + sparkles when the real jerboa is bopped. */
  private drawBoop(ctx: MicroGameCtx): void {
    const { ink, services } = ctx
    const h = this.holes[this.boopHole]!
    const s = this.s
    drawSparkleBurst(ink, 'mirageboop', h.x, h.y - 20 * s, this.boopAt, 'yellow', 10)
    if (this.boopAt < 0.5) {
      const pop = Math.min(1, this.boopAt / 0.09)
      inkText(ink, 'mirageboop-t', services.t('game.mirage.boop'), h.x, h.y - 70 * s, 34 * s * pop, {
        align: 'center', baseline: 'middle', color: NOTEBOOK.markerRed, width: 4.4 * s,
        rotate: -0.16, tilt: 0.1, halo: 0.2,
        alpha: Math.max(0, 1 - Math.max(0, (this.boopAt - 0.32) / 0.18))
      })
    }
  }

  /** A poof of empty ink when a mirage is tapped. */
  private drawPoof(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    const grow = Math.min(1, this.poofAt * 4)
    const alpha = Math.max(0, 1 - this.poofAt * 2.2)
    const rng = makeRng('miragepoof', ink.boil)
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2
      const d = grow * 40 * s
      ink.circle(`poof${i}`, this.poofX + Math.cos(a) * d, this.poofY + Math.sin(a) * d,
        (6 + grow * 8) * s, { color: NOTEBOOK.inkSoft, width: 2.4 * s, passes: 1, alpha: alpha * 0.6 })
    }
  }

  /** The heat-shimmer overlay: wavy horizontal pencil lines rippling up the
   *  page — the "you can't quite trust your eyes" haze. */
  private drawShimmer(ctx: MicroGameCtx): void {
    const { ink, t } = ctx
    const st = ink.stage
    const s = this.s
    const rows = 9
    for (let r = 0; r < rows; r++) {
      const y = st.y + st.h * (0.18 + r / rows * 0.72)
      const pts: Pt[] = []
      for (let k = 0; k <= 12; k++) {
        const fx = k / 12
        pts.push({
          x: st.x + fx * st.w,
          // A travelling sine so the haze visibly ripples upward.
          y: y + Math.sin(fx * 7 + t * 3 + r) * 5 * s
        })
      }
      ink.stroke(`shimmer${r}`, pts, {
        color: HIGHLIGHT.orange, width: 2 * s, passes: 1, alpha: 0.12, rough: 1
      })
    }
  }

  private drawTally(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    const st = ink.stage
    for (let i = 0; i < TO_WIN; i++) {
      const cx = st.cx + (i - 1) * 44 * s
      const cy = st.y + st.h * 0.1
      const done = i < this.bopped
      ink.circle(`mtally${i}`, cx, cy, 13 * s, {
        color: done ? HIGHLIGHT.yellow : NOTEBOOK.inkSoft, width: 3.4 * s, passes: 1, alpha: done ? 1 : 0.6
      })
      if (done) ink.fillCircle(cx, cy, 8 * s, HIGHLIGHT.yellow, 0.85)
    }
  }

  /** Dev-only view (GameScene's `state().detail`): where the real jerboa is +
   *  whether its ring is hot, so a scripted test can tap it on the beat. */
  debug() {
    const h = this.holes[this.solid]!
    return {
      bopped: this.bopped,
      solid: this.solid,
      solidX: Math.round(h.x),
      solidY: Math.round(h.y - this.jerboaLift(h) - 10 * this.s),
      hot: isHot(h.ring),
      ring: +h.ring.ring.toFixed(2)
    }
  }
}

export const mirageWhack = (): MicroGame => new MirageWhack()
