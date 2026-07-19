// ─── Micro-game 2: Mosquitoes — "SWAT!" ────────────────────────────────────
//
// GDD §4.2 / vision-board panel 5: a close-up of a freckled forearm across the
// page. Three cartoon mosquitoes with glowing red eyes hover over the skin,
// each ringed by a circle that shrinks toward its body. Click each one at the
// instant its ring collapses.
//
// ── On the timing window ──
// The GDD says click "exactly when the outer ring collapses into the inner
// circle". Taken literally on a 5-second clock with three targets, that's an
// Osu!-grade demand inside a game whose entire briefing is one word — and a
// miss costs a heart. So the window is generous (see `HIT_WINDOW`) and, more
// importantly, an early or late click is NOT an instant loss: it just doesn't
// count, and the ring recycles. The player loses only by running out the
// clock. That keeps the panic without making the game feel like it cheated.
//
// ── On the fail state ──
// GDD §4.2's lose condition mentions "missing the timing window", but the core
// loop already turns a timeout into a loss, and a single mistimed tap ending
// the round would be brutal at 3AM. The swelling red lump and the buzzing loop
// still happen — they're the punishment for a miss — they just don't end it.

import type { MicroGame, MicroGameCtx } from '../types'
import { NOTEBOOK, HIGHLIGHT } from '@/use/ink/palette'
import { mulberry32, range, makeRng } from '@/use/ink/rng'
import { smack, mosquitoBuzz, penClick, type Loop } from '@/use/ink/useInkAudio'
import { inkText } from '@/use/ink/strokeFont'
import type { Pt } from '@/use/ink/inkRenderer'

/** How close to the collapse a tap must land, in ring-progress units (the
 *  ring goes 1 → 0). 0.16 ≈ a fifth of a second at the default ring speed. */
const HIT_WINDOW = 0.16
const COUNT = 3

interface Mosquito {
  x: number
  y: number
  /** Ring progress: starts at 1 (wide), shrinks to 0 (collapsed onto body). */
  ring: number
  /** Rings per second. */
  speed: number
  dead: boolean
  /** Seconds since it was swatted — drives the SMACK pop. */
  deadAt: number
  /** Set on a mistimed tap; drives the swelling lump + a flash of red. */
  missed: number
  /** Phase offset so the three don't bob in lockstep. */
  phase: number
  /** Which freckle-cluster of the arm it hovers over. */
  bob: number
}

class MosquitoSwat implements MicroGame {
  readonly id = 'mosquito'
  readonly verbKey = 'game.mosquito.verb'
  readonly hintKey = 'game.mosquito.hint'
  readonly baseDuration = 5

  private bugs: Mosquito[] = []
  private buzz: Loop | null = null
  private rng: () => number = Math.random
  /** Arm geometry — a diagonal band across the page (vision-board panel 5). */
  private armA: Pt = { x: 0, y: 0 }
  private armB: Pt = { x: 0, y: 0 }
  private armW = 0
  private lumps: Array<{ x: number; y: number; at: number }> = []

  init(ctx: MicroGameCtx, seed: number): void {
    const { ink } = ctx
    this.rng = mulberry32(seed)
    this.lumps = []

    // The arm runs corner to corner across the STAGE box, bleeding off both
    // page edges. Anchoring the ends to the stage keeps the diagonal at a
    // sane angle on a tall phone (against the raw page it would rear up into
    // a near-vertical stripe) while the arm still runs off-screen both sides.
    const st = ink.stage
    this.armA = { x: -ink.u(40), y: st.y + st.h * 0.72 }
    this.armB = { x: ink.pw + ink.u(40), y: st.y + st.h * 0.26 }
    this.armW = st.w * 0.34

    // Space the bugs along the arm so they never overlap — three targets
    // stacked on top of each other would make the tap ambiguous, and an
    // ambiguous tap on a 5s clock is just theft.
    this.bugs = []
    for (let i = 0; i < COUNT; i++) {
      const along = 0.24 + (i / (COUNT - 1)) * 0.52 + range(this.rng, -0.04, 0.04)
      const across = range(this.rng, -0.3, 0.3)
      const p = this.pointOnArm(along, across)
      this.bugs.push({
        x: p.x,
        y: p.y,
        ring: 1,
        // Staggered speeds so the three collapse at different moments —
        // simultaneous collapses would be untappable with one finger.
        speed: 0.42 + i * 0.1 + range(this.rng, -0.03, 0.03),
        dead: false,
        deadAt: 0,
        missed: 0,
        phase: range(this.rng, 0, Math.PI * 2),
        bob: 0
      })
    }

    this.buzz?.stop()
    this.buzz = mosquitoBuzz()
    this.buzz?.setIntensity(0.5)
  }

  /** A point on the arm band. `along` 0..1 down its length, `across` -1..1
   *  across its width.
   *
   *  The band TAPERS from elbow to wrist — a constant-width strip reads as a
   *  ruler or a length of tape, not a limb. The taper is what makes the eye
   *  accept it as an arm at a glance, which matters when the player has five
   *  seconds to parse the page. */
  private pointOnArm(along: number, across: number): Pt {
    const dx = this.armB.x - this.armA.x
    const dy = this.armB.y - this.armA.y
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len
    const ny = dx / len
    const taper = 1.18 - along * 0.42
    return {
      x: this.armA.x + dx * along + nx * across * this.armW * 0.5 * taper,
      y: this.armA.y + dy * along + ny * across * this.armW * 0.5 * taper
    }
  }

  /** Direction the arm runs, in radians. */
  private get armAngle(): number {
    return Math.atan2(this.armB.y - this.armA.y, this.armB.x - this.armA.x)
  }

  /** The arm outline as a polygon, sampled along its length so the taper
   *  actually curves instead of being a trapezoid. */
  private armOutline(steps = 10): Pt[] {
    const top: Pt[] = []
    const bottom: Pt[] = []
    for (let i = 0; i <= steps; i++) {
      const f = i / steps
      top.push(this.pointOnArm(f, -1))
      bottom.push(this.pointOnArm(f, 1))
    }
    return [...top, ...bottom.reverse()]
  }

  update(ctx: MicroGameCtx, dt: number) {
    const { pointer, ink, services, t } = ctx

    let alive = 0
    let closest = 0
    for (const b of this.bugs) {
      if (b.dead) {
        b.deadAt += dt
        continue
      }
      alive++
      b.ring -= b.speed * dt
      // The ring recycles rather than vanishing: a missed collapse gives the
      // player another pass instead of a dead target they can never clear.
      if (b.ring <= -HIT_WINDOW) b.ring = 1
      if (b.missed > 0) b.missed += dt
      b.bob = Math.sin(t * 6 + b.phase) * this.armW * 0.024
      closest = Math.max(closest, 1 - Math.abs(b.ring))
    }

    // The whine tightens as the nearest ring closes — the audio tell that
    // something is about to be tappable.
    this.buzz?.setIntensity(alive === 0 ? 0 : 0.35 + closest * 0.65)

    if (pointer.pressed) {
      const hitR = this.armW * 0.36 // forgiving: thumbs, not styluses
      let best: Mosquito | null = null
      let bestD = Infinity
      for (const b of this.bugs) {
        if (b.dead) continue
        const d = Math.hypot(pointer.x - b.x, pointer.y - (b.y + b.bob))
        if (d < hitR && d < bestD) {
          bestD = d
          best = b
        }
      }
      if (best) {
        if (Math.abs(best.ring) <= HIT_WINDOW) {
          best.dead = true
          best.deadAt = 0
          smack()
          // "A high-frequency, sudden snapping jar" (GDD §5).
          services.shake('snap')
          // The impact frame is reserved for real hits — this is the one
          // moment in the game that earns a full-screen invert.
          services.impactFrame(2)
        } else {
          // Mistimed: a lump swells and the whine gets angrier, but the round
          // continues.
          best.missed = 0.001
          this.lumps.push({ x: best.x, y: best.y + best.bob, at: 0 })
          penClick()
          services.shake('tick')
        }
      }
    }

    for (const l of this.lumps) l.at += dt

    if (this.bugs.every((b) => b.dead)) return 'won'
    return undefined
  }

  /** Dev-only view (GameScene's `__midnight.state().detail`) — live bug
   *  positions plus whether each is inside its hit window, so an automated
   *  session can aim and time taps instead of eyeballing screenshots. */
  debug() {
    return {
      killed: this.bugs.filter((b) => b.dead).length,
      bugs: this.bugs.map((b) => ({
        x: Math.round(b.x),
        y: Math.round(b.y + b.bob),
        dead: b.dead,
        hot: Math.abs(b.ring) <= HIT_WINDOW
      }))
    }
  }

  draw(ctx: MicroGameCtx): void {
    this.drawArm(ctx)
    for (const l of this.lumps) this.drawLump(ctx, l)
    for (let i = 0; i < this.bugs.length; i++) {
      const b = this.bugs[i]!
      if (b.dead) this.drawSplat(ctx, b, i)
      else this.drawBug(ctx, b, i)
    }
  }

  drawOutcome(ctx: MicroGameCtx, outcome: 'won' | 'lost', since: number): void {
    this.drawArm(ctx)
    for (const l of this.lumps) this.drawLump(ctx, l)
    for (let i = 0; i < this.bugs.length; i++) {
      const b = this.bugs[i]!
      if (b.dead) this.drawSplat(ctx, b, i)
      else if (outcome === 'lost') {
        // The survivors bite: a lump swells where each one still sits.
        this.drawBug(ctx, b, i)
        this.drawLump(ctx, { x: b.x, y: b.y + b.bob, at: since })
      }
    }
  }

  /** The forearm: a freckled, tapered band with cross-hatched shading down one
   *  edge. */
  private drawArm(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const outline = this.armOutline()

    // Skin — a warm wash, kept pale so the ink reads on top.
    ink.fill(outline, '#f2d9c4', 0.85)

    // Shade the lower third. The hatch runs ALONG the arm, not across it:
    // strokes perpendicular to a limb read as a barcode (or worse, as a
    // ruler's tick marks), whereas strokes following the form read as the
    // curve rolling away from the light.
    const shade: Pt[] = []
    for (let i = 0; i <= 10; i++) shade.push(this.pointOnArm(i / 10, 0.3))
    for (let i = 10; i >= 0; i--) shade.push(this.pointOnArm(i / 10, 1))
    ink.hatch('armshade', shade, {
      gap: ink.u(10),
      angle: this.armAngle,
      color: NOTEBOOK.inkSoft,
      alpha: 0.2,
      width: ink.u(1.5),
      rough: 2
    })

    // Outline the two long edges only — capping the ends would close the arm
    // into a shape, and it's meant to run off both sides of the page.
    const topEdge: Pt[] = []
    const botEdge: Pt[] = []
    for (let i = 0; i <= 10; i++) {
      topEdge.push(this.pointOnArm(i / 10, -1))
      botEdge.push(this.pointOnArm(i / 10, 1))
    }
    ink.stroke('arm-a', topEdge, { width: ink.u(4.5), bleed: true })
    ink.stroke('arm-b', botEdge, { width: ink.u(4.5), bleed: true })

    // Freckles + hairs (GDD §4.2: "freckled, hairy forearm").
    const rng = makeRng('freckles', 0)
    for (let i = 0; i < 26; i++) {
      const p = this.pointOnArm(range(rng, 0.05, 0.95), range(rng, -0.8, 0.8))
      ink.fillCircle(p.x, p.y, ink.u(range(rng, 1.6, 3.4)), '#b9744e', range(rng, 0.4, 0.8))
    }
    for (let i = 0; i < 12; i++) {
      const p = this.pointOnArm(range(rng, 0.06, 0.94), range(rng, -0.9, 0.9))
      const a2 = range(rng, -0.7, 0.7) - Math.PI / 2
      ink.stroke(`hair${i}`, [
        { x: p.x, y: p.y },
        { x: p.x + Math.cos(a2) * ink.u(14), y: p.y + Math.sin(a2) * ink.u(14) }
      ], { color: NOTEBOOK.inkSoft, width: ink.u(1.4), passes: 1, alpha: 0.6, rough: 2 })
    }
  }

  private drawBug(ctx: MicroGameCtx, b: Mosquito, i: number): void {
    const { ink, t } = ctx
    const y = b.y + b.bob
    const bodyR = this.armW * 0.13

    // The approach ring. It's a highlighter circle so it reads as "touch me"
    // in the game's own visual language, and it turns hot pink inside the hit
    // window — the tell the player actually reacts to.
    const ringR = bodyR + Math.max(0, b.ring) * this.armW * 0.46
    const hot = Math.abs(b.ring) <= HIT_WINDOW
    ink.circle(`ring${i}`, b.x, y, ringR, {
      color: hot ? HIGHLIGHT.pink : HIGHLIGHT.cyan,
      width: hot ? ink.u(9) : ink.u(5),
      passes: hot ? 2 : 1,
      rough: 2.4,
      alpha: hot ? 1 : 0.75
    })
    if (hot) {
      // A brief flare at the moment of collapse.
      ink.highlightBlob(`flare${i}`, b.x, y, bodyR * 2.1, 'pink', 0.4)
    }

    // Wings — "transparent vibrating wings". Flap at the boil rate so they
    // strobe rather than blur.
    const flap = ink.boil % 2 === 0 ? 1 : 0.55
    for (let s = 0; s < 2; s++) {
      const dir = s === 0 ? -1 : 1
      ink.ellipse(
        `wing${i}${s}`, b.x + dir * bodyR * 0.7, y - bodyR * 0.9,
        bodyR * 1.1, bodyR * 0.42 * flap, dir * 0.5,
        { color: NOTEBOOK.inkSoft, width: ink.u(2), passes: 1, alpha: 0.55 }
      )
    }

    // Body + abdomen.
    ink.fill(
      [
        { x: b.x - bodyR * 0.5, y: y - bodyR * 0.4 },
        { x: b.x + bodyR * 0.5, y: y - bodyR * 0.4 },
        { x: b.x + bodyR * 1.5, y: y + bodyR * 0.7 },
        { x: b.x - bodyR * 0.4, y: y + bodyR * 0.5 }
      ],
      NOTEBOOK.ink, 0.9
    )
    ink.ellipse(`body${i}`, b.x, y, bodyR * 0.8, bodyR * 0.55, 0.2, { width: ink.u(3) })

    // Legs.
    for (let s = 0; s < 3; s++) {
      const a = Math.PI * (0.25 + s * 0.22)
      ink.stroke(`leg${i}${s}`, [
        { x: b.x, y: y + bodyR * 0.2 },
        { x: b.x + Math.cos(a) * bodyR * 1.4, y: y + Math.sin(a) * bodyR * 1.4 },
        { x: b.x + Math.cos(a) * bodyR * 1.7, y: y + Math.sin(a) * bodyR * 2.2 }
      ], { width: ink.u(1.8), passes: 1, rough: 1.6 })
    }

    // "Giant glowing red eyes" — the read at a glance.
    const glow = 0.6 + Math.sin(t * 12 + b.phase) * 0.25
    for (let s = 0; s < 2; s++) {
      const ex = b.x + (s === 0 ? -1 : 1) * bodyR * 0.42
      const ey = y - bodyR * 0.5
      ink.fillCircle(ex, ey, bodyR * 0.34, NOTEBOOK.markerRed, glow)
      ink.circle(`eye${i}${s}`, ex, ey, bodyR * 0.34, { width: ink.u(1.8), passes: 1 })
    }
    // Proboscis, aimed at the skin.
    ink.stroke(`nose${i}`, [
      { x: b.x, y: y + bodyR * 0.3 },
      { x: b.x, y: y + bodyR * 1.5 }
    ], { width: ink.u(2), passes: 1, color: NOTEBOOK.markerRed })
  }

  /** The kill: a comical hand-slam overlay, SMACK popup and red splatter
   *  (GDD §4.2). */
  private drawSplat(ctx: MicroGameCtx, b: Mosquito, i: number): void {
    const { ink, services } = ctx
    const age = b.deadAt
    const y = b.y + b.bob

    ink.splatter(`sp${i}`, b.x, y, ink.u(24), NOTEBOOK.markerRed, 12, 3)

    // The hand slams in over the first ~0.12s and lifts away.
    if (age < 0.34) {
      const drop = Math.max(0, 1 - age / 0.12)
      const lift = Math.max(0, (age - 0.16) / 0.18)
      const hy = y - drop * ink.u(90) - lift * ink.u(70)
      const alpha = 1 - lift
      ink.ctx.save()
      ink.ctx.globalAlpha = alpha
      this.drawHand(ctx, b.x, hy, `hand${i}`)
      ink.ctx.restore()
    }

    if (age < 0.5) {
      const pop = Math.min(1, age / 0.09)
      inkText(ink, `smack${i}`, services.t('game.mosquito.smack'), b.x + ink.u(40), y - ink.u(52), ink.u(40) * pop, {
        align: 'center',
        baseline: 'middle',
        color: NOTEBOOK.markerRed,
        width: ink.u(5),
        rotate: -0.22,
        tilt: 0.1,
        alpha: Math.max(0, 1 - Math.max(0, (age - 0.32) / 0.18))
      })
      ink.actionLines(`smackact${i}`, b.x, y, ink.u(30), ink.u(30) + age * ink.u(160), 8, NOTEBOOK.markerRed)
    }
  }

  /** A crude open palm, seen from behind — cartoon-flat on purpose. */
  private drawHand(ctx: MicroGameCtx, cx: number, cy: number, id: string): void {
    const { ink } = ctx
    const r = ink.u(58)
    const palm: Pt[] = [
      { x: cx - r * 0.8, y: cy + r * 0.9 },
      { x: cx - r * 0.9, y: cy - r * 0.2 },
      { x: cx - r * 0.5, y: cy - r * 0.85 },
      { x: cx + r * 0.1, y: cy - r * 1.0 },
      { x: cx + r * 0.7, y: cy - r * 0.75 },
      { x: cx + r * 0.95, y: cy - r * 0.1 },
      { x: cx + r * 0.8, y: cy + r * 0.9 }
    ]
    ink.fill(palm, '#f2d9c4', 0.95)
    ink.shape(id, palm, { width: ink.u(4), bleed: true })
    // Knuckle creases.
    for (let i = 0; i < 3; i++) {
      const kx = cx - r * 0.4 + i * r * 0.4
      ink.stroke(`${id}k${i}`, [
        { x: kx, y: cy - r * 0.55 }, { x: kx, y: cy - r * 0.25 }
      ], { width: ink.u(2), passes: 1, alpha: 0.6 })
    }
  }

  /** "A red highlighter lump swells up on the arm" (GDD §4.2). */
  private drawLump(ctx: MicroGameCtx, l: { x: number; y: number; at: number }): void {
    const { ink } = ctx
    const grow = Math.min(1, l.at * 4)
    const r = ink.u(16) + grow * ink.u(16)
    ink.highlightBlob(`lump${Math.round(l.x)}${Math.round(l.y)}`, l.x, l.y, r, 'pink', 0.5)
    ink.circle(`lumpo${Math.round(l.x)}${Math.round(l.y)}`, l.x, l.y, r * 0.7, {
      color: NOTEBOOK.markerRed, width: ink.u(2.4), passes: 1, alpha: 0.8
    })
  }

  dispose(): void {
    this.buzz?.stop()
    this.buzz = null
  }
}

export const mosquitoSwat = (): MicroGame => new MosquitoSwat()
