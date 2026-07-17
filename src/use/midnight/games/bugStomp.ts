// ─── Micro-game: Bug Stomp — "STOMP!" ──────────────────────────────────────
//
// A top-down view of the floor. Several ants and beetles scurry across it. Tap
// each one to stomp it flat before the 10-second match burns out. Miss one and
// the clock is your enemy; a stray tap on bare floor just kicks up dust.
//
// ── How it differs from Mosquito Swat ──
// Mosquito is a RHYTHM game: stationary targets, timing rings, click on the
// beat. Stomp is a CHASE: the targets move, there is no timing window, and the
// whole challenge is catching wandering things with a fat thumb before time
// runs out. Same "clear all the targets" shape, opposite skill.
//
// ── On the clock ──
// baseDuration is 10s (the user's spec). The core loop still squeezes it down
// with escalation (10/speed), so a late-night stomp is a genuine scramble —
// which is fine, because catching moving bugs scales smoothly with less time
// in a way a fixed puzzle would not.

import type { MicroGame, MicroGameCtx } from '../types'
import { NOTEBOOK, HIGHLIGHT } from '@/use/ink/palette'
import { mulberry32, range, makeRng, pick } from '@/use/ink/rng'
import { splat, penClick, chime } from '@/use/ink/useInkAudio'
import { inkText } from '@/use/ink/strokeFont'
import type { InkRenderer, Pt } from '@/use/ink/inkRenderer'

type BugKind = 'ant' | 'beetle'

interface Bug {
  x: number
  y: number
  /** Heading in radians — the body points this way. */
  heading: number
  /** Current crawl speed, page units/sec. */
  speed: number
  kind: BugKind
  /** Body size in page units. */
  size: number
  dead: boolean
  deadAt: number
  /** Seconds until the next wander decision. */
  wanderT: number
  /** Seconds of a mid-scurry freeze (ants dart, then stop). 0 = moving. */
  pauseT: number
  /** Leg-cycle phase, advanced by distance travelled. */
  legPhase: number
  /** Squash colour, chosen at kill so not every bug bleeds the same. */
  squashHue: string
}

/** How many bugs to clear. A handful — "several" — and comfortably tappable in
 *  10s, tightening as escalation shrinks the clock. */
const BUG_COUNT = 6

class BugStomp implements MicroGame {
  readonly id = 'stomp'
  readonly verbKey = 'game.stomp.verb'
  readonly hintKey = 'game.stomp.hint'
  readonly baseDuration = 10

  private bugs: Bug[] = []
  private rng: () => number = Math.random
  private s = 1
  /** The floor rectangle (the stage), in page units. */
  private fx = 0
  private fy = 0
  private fw = 0
  private fh = 0
  /** The stomp stamp: where the last tap landed and how long ago. */
  private stompX = 0
  private stompY = 0
  private stompAt = 99
  private stompHit = false
  private killed = 0
  private wonAt = -1

  init(ctx: MicroGameCtx, seed: number): void {
    const { ink } = ctx
    const st = ink.stage
    this.rng = mulberry32(seed)
    this.s = st.w * 0.0016
    this.fx = st.x
    this.fy = st.y
    this.fw = st.w
    this.fh = st.h
    this.stompAt = 99
    this.killed = 0
    this.wonAt = -1

    // A mix of ants (small, fast, darty) and beetles (bigger, slower, steady).
    this.bugs = []
    for (let i = 0; i < BUG_COUNT; i++) {
      const kind: BugKind = this.rng() < 0.6 ? 'ant' : 'beetle'
      this.bugs.push(this.spawnBug(kind, i))
    }
  }

  private spawnBug(kind: BugKind, i: number): Bug {
    const rng = this.rng
    // Spread the initial positions across the floor with a margin so none spawn
    // half-off the page or behind the binding.
    const m = Math.max(90 * this.s, this.fw * 0.1)
    return {
      x: range(rng, this.fx + m, this.fx + this.fw - m),
      y: range(rng, this.fy + m, this.fy + this.fh - m),
      heading: range(rng, 0, Math.PI * 2),
      speed: kind === 'ant' ? range(rng, 150, 230) * this.s : range(rng, 80, 130) * this.s,
      kind,
      size: (kind === 'ant' ? range(rng, 20, 26) : range(rng, 30, 38)) * this.s,
      dead: false,
      deadAt: 0,
      wanderT: range(rng, 0.2, 0.8),
      pauseT: 0,
      legPhase: range(rng, 0, Math.PI * 2),
      squashHue: pick(rng, ['#3a4a1e', '#4a3a1e', '#2a2a30'])
    }
  }

  update(ctx: MicroGameCtx, dt: number) {
    const { pointer, services } = ctx
    this.stompAt += dt
    if (this.wonAt >= 0) this.wonAt += dt

    // ── Crawl ──
    // Keep bugs a comfortable inset from the floor edges so none hide behind
    // the spiral binding / page margin, and every one stays a tappable target.
    const margin = Math.max(55 * this.s, this.fw * 0.07)
    for (const b of this.bugs) {
      if (b.dead) { b.deadAt += dt; continue }

      // Wander: occasionally turn; ants also dart-and-freeze.
      b.wanderT -= dt
      if (b.pauseT > 0) {
        b.pauseT -= dt
      } else if (b.wanderT <= 0) {
        // A new heading, biased toward keeping roughly the same direction so
        // the motion reads as purposeful scurrying, not a random-walk jitter.
        b.heading += range(this.rng, -1.1, 1.1)
        b.wanderT = range(this.rng, 0.25, 0.75)
        // Ants stutter to a stop now and then — that dart-pause-dart cadence is
        // the whole "ant" read.
        if (b.kind === 'ant' && this.rng() < 0.35) b.pauseT = range(this.rng, 0.1, 0.3)
      }

      if (b.pauseT <= 0) {
        const vx = Math.cos(b.heading) * b.speed
        const vy = Math.sin(b.heading) * b.speed
        b.x += vx * dt
        b.y += vy * dt
        b.legPhase += (b.speed / this.s) * dt * 0.05

        // Bounce off the floor edges — steer back in rather than sticking.
        if (b.x < this.fx + margin) { b.x = this.fx + margin; b.heading = Math.PI - b.heading }
        else if (b.x > this.fx + this.fw - margin) { b.x = this.fx + this.fw - margin; b.heading = Math.PI - b.heading }
        if (b.y < this.fy + margin) { b.y = this.fy + margin; b.heading = -b.heading }
        else if (b.y > this.fy + this.fh - margin) { b.y = this.fy + this.fh - margin; b.heading = -b.heading }
      }
    }

    // ── Stomp ──
    if (pointer.pressed) {
      this.stompX = pointer.x
      this.stompY = pointer.y
      this.stompAt = 0
      // Generous grab radius — a thumb stomping a moving target must forgive.
      const stompR = 74 * this.s
      let best: Bug | null = null
      let bestD = Infinity
      for (const b of this.bugs) {
        if (b.dead) continue
        const d = Math.hypot(pointer.x - b.x, pointer.y - b.y)
        if (d < stompR + b.size && d < bestD) { bestD = d; best = b }
      }
      if (best) {
        best.dead = true
        best.deadAt = 0
        this.killed++
        this.stompHit = true
        splat()
        services.shake('snap')
        services.impactFrame(2)
      } else {
        // A stomp on bare floor — a puff of dust, no kill.
        this.stompHit = false
        penClick()
        services.shake('tick')
      }
    }

    if (this.bugs.every((b) => b.dead)) {
      if (this.wonAt < 0) { this.wonAt = 0; chime(2) }
      return 'won'
    }
    return undefined
  }

  draw(ctx: MicroGameCtx): void {
    this.drawFloor(ctx)
    // Dead bugs first (splats sit UNDER live bugs and the stomp).
    for (let i = 0; i < this.bugs.length; i++) {
      if (this.bugs[i]!.dead) this.drawSquash(ctx, this.bugs[i]!, i)
    }
    for (let i = 0; i < this.bugs.length; i++) {
      if (!this.bugs[i]!.dead) this.drawBug(ctx, this.bugs[i]!, i)
    }
    this.drawStomp(ctx)
    this.drawTally(ctx)
  }

  drawOutcome(ctx: MicroGameCtx, outcome: 'won' | 'lost', since: number): void {
    this.drawFloor(ctx)
    for (let i = 0; i < this.bugs.length; i++) {
      const b = this.bugs[i]!
      if (b.dead) this.drawSquash(ctx, b, i)
      else if (outcome === 'lost') this.drawBug(ctx, b, i) // survivors scatter on
    }
    if (outcome === 'lost') {
      // The survivors carry on crawling — the floor is theirs.
      this.drawTally(ctx)
    }
  }

  /** The floor, seen top-down: paper with scattered pebbles, dirt speckle and
   *  a few grass tufts, so the bugs have somewhere to crawl. */
  private drawFloor(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    // Static layout (boil 0) so the ground furniture doesn't wander frame to
    // frame; the ink renderer still boils each stroke's wobble.
    const rng = makeRng('floor', 0)
    // A faint warm dirt wash so it reads as ground, not blank page.
    ink.ctx.save()
    ink.ctx.globalAlpha = 0.14
    ink.ctx.fillStyle = '#c9b48a'
    ink.ctx.fillRect(this.fx, this.fy, this.fw, this.fh)
    ink.ctx.restore()

    // Dirt speckle.
    for (let i = 0; i < 40; i++) {
      ink.fillCircle(
        range(rng, this.fx, this.fx + this.fw),
        range(rng, this.fy, this.fy + this.fh),
        range(rng, 1, 3) * s, NOTEBOOK.inkSoft, range(rng, 0.15, 0.4)
      )
    }
    // Pebbles.
    for (let i = 0; i < 7; i++) {
      const px = range(rng, this.fx + 40 * s, this.fx + this.fw - 40 * s)
      const py = range(rng, this.fy + 40 * s, this.fy + this.fh - 40 * s)
      const pr = range(rng, 10, 20) * s
      ink.fill([
        { x: px - pr, y: py + pr * 0.3 }, { x: px - pr * 0.5, y: py - pr * 0.6 },
        { x: px + pr * 0.6, y: py - pr * 0.5 }, { x: px + pr, y: py + pr * 0.4 }
      ], '#c8c4bc', 0.55)
      ink.circle(`pebble${i}`, px, py, pr, { color: NOTEBOOK.inkSoft, width: 2 * s, passes: 1, alpha: 0.5 })
    }
    // Grass tufts.
    for (let i = 0; i < 6; i++) {
      const gx = range(rng, this.fx + 30 * s, this.fx + this.fw - 30 * s)
      const gy = range(rng, this.fy + 30 * s, this.fy + this.fh - 30 * s)
      for (let k = -1; k <= 1; k++) {
        ink.stroke(`grass${i}_${k}`, [
          { x: gx + k * 6 * s, y: gy + 10 * s },
          { x: gx + k * 12 * s, y: gy - 18 * s }
        ], { color: NOTEBOOK.markerGreen, width: 2.4 * s, passes: 1, alpha: 0.5, rough: 2 })
      }
    }
  }

  /** A crawling bug, oriented along its heading. */
  private drawBug(ctx: MicroGameCtx, b: Bug, i: number): void {
    const { ink } = ctx
    const s = this.s
    ink.transformed(b.x, b.y, b.heading + Math.PI / 2, 1, () => {
      // Everything below is drawn in a body frame: +y is "forward" (heading),
      // so the bug's head points along its travel. Legs animate on legPhase.
      const legSwing = Math.sin(b.legPhase * 6) * 0.4
      if (b.kind === 'ant') this.drawAnt(ink, b, i, legSwing)
      else this.drawBeetle(ink, b, i, legSwing)
    })
  }

  private drawAnt(ink: InkRenderer, b: Bug, i: number, swing: number): void {
    const s = this.s
    const r = b.size
    const col = NOTEBOOK.ink
    // Six legs — three per side, splaying and sweeping.
    for (let side = -1; side <= 1; side += 2) {
      for (let l = 0; l < 3; l++) {
        const ly = (l - 1) * r * 0.5
        const sw = swing * (l === 1 ? -1 : 1)
        ink.stroke(`ant${i}leg${side}${l}`, [
          { x: side * r * 0.25, y: ly },
          { x: side * r * 0.9, y: ly + (sw + 0.2) * r },
          { x: side * r * 1.25, y: ly + (sw + 0.5) * r }
        ], { color: col, width: 2 * s, passes: 1, rough: 1.4 })
      }
    }
    // Three body segments along the heading (+y): gaster (back), thorax, head.
    ink.fillCircle(0, -r * 0.85, r * 0.55, col, 0.95)  // gaster
    ink.fillCircle(0, 0, r * 0.4, col, 0.95)           // thorax
    ink.fillCircle(0, r * 0.75, r * 0.5, col, 0.95)    // head
    // Antennae.
    for (let side = -1; side <= 1; side += 2) {
      ink.stroke(`ant${i}ant${side}`, [
        { x: side * r * 0.2, y: r * 1.0 },
        { x: side * r * 0.55, y: r * 1.5 }
      ], { color: col, width: 1.8 * s, passes: 1, rough: 1.2 })
    }
  }

  private drawBeetle(ink: InkRenderer, b: Bug, i: number, swing: number): void {
    const s = this.s
    const r = b.size
    const col = NOTEBOOK.ink
    // Legs.
    for (let side = -1; side <= 1; side += 2) {
      for (let l = 0; l < 3; l++) {
        const ly = (l - 1) * r * 0.55
        const sw = swing * (l === 1 ? -1 : 1)
        ink.stroke(`beetle${i}leg${side}${l}`, [
          { x: side * r * 0.55, y: ly },
          { x: side * r * 1.0, y: ly + (sw + 0.2) * r }
        ], { color: col, width: 2.4 * s, passes: 1, rough: 1.2 })
      }
    }
    // A domed oval shell.
    ink.ellipse(`beetle${i}shell`, 0, -r * 0.05, r * 0.72, r, 0, {
      color: col, width: 3 * s, passes: 2, bleed: true
    })
    ink.fill([
      { x: -r * 0.72, y: -r * 0.05 }, { x: 0, y: -r * 1.05 },
      { x: r * 0.72, y: -r * 0.05 }, { x: 0, y: r * 0.95 }
    ], '#26262e', 0.9)
    // Elytra split down the back.
    ink.stroke(`beetle${i}seam`, [
      { x: 0, y: -r * 0.9 }, { x: 0, y: r * 0.7 }
    ], { color: '#000', width: 2 * s, passes: 1, alpha: 0.6 })
    // Little head poking out the front.
    ink.fillCircle(0, r * 0.95, r * 0.32, col, 0.95)
  }

  /** A stomped bug: a flat splat with a couple of legs still poking out. */
  private drawSquash(ctx: MicroGameCtx, b: Bug, i: number): void {
    const { ink, services } = ctx
    const s = this.s
    const grow = Math.min(1, b.deadAt * 5)
    const r = b.size * (1 + grow * 0.6)
    // The squish: an irregular flat blot in a muddy hue.
    ink.splatter(`squash${i}`, b.x, b.y, r * 0.7, b.squashHue, 8, 2.4)
    // A few legs splayed out from under it.
    const rng = makeRng(`squashlegs${i}`, 0)
    for (let k = 0; k < 5; k++) {
      const a = range(rng, 0, Math.PI * 2)
      ink.stroke(`squash${i}leg${k}`, [
        { x: b.x + Math.cos(a) * r * 0.5, y: b.y + Math.sin(a) * r * 0.5 },
        { x: b.x + Math.cos(a) * r * 1.1, y: b.y + Math.sin(a) * r * 1.1 }
      ], { color: NOTEBOOK.ink, width: 2 * s, passes: 1, rough: 1.6 })
    }
    // A brief "SPLAT!" pop.
    if (b.deadAt < 0.5) {
      const pop = Math.min(1, b.deadAt / 0.09)
      inkText(ink, `splat${i}`, services.t('game.stomp.splat'), b.x + r * 0.6, b.y - r * 1.4, r * 1.5 * pop, {
        align: 'center',
        baseline: 'middle',
        color: NOTEBOOK.markerRed,
        width: r * 0.16,
        rotate: -0.2,
        tilt: 0.1,
        halo: 0.2,
        alpha: Math.max(0, 1 - Math.max(0, (b.deadAt - 0.32) / 0.18))
      })
    }
  }

  /** The boot sole slamming down where the player tapped. */
  private drawStomp(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    if (this.stompAt > 0.3) return
    const age = this.stompAt
    const drop = Math.max(0, 1 - age / 0.07)
    const lift = Math.max(0, (age - 0.12) / 0.18)
    const alpha = 1 - lift
    const scale = 1 + drop * 0.25
    const x = this.stompX
    const y = this.stompY - lift * 40 * s

    // Dust ring on impact.
    if (age < 0.22) {
      ink.actionLines('stompdust', this.stompX, this.stompY, 30 * s, (30 + age * 220) * s, 9, NOTEBOOK.inkSoft)
    }

    ink.ctx.save()
    ink.ctx.globalAlpha = alpha
    ink.transformed(x, y, 0, scale, () => {
      // A boot sole: ball of the foot (big rounded) + heel (smaller), from
      // above. Tread as a few cross-lines.
      ink.ellipse('stomp-ball', 0, -14 * s, 40 * s, 52 * s, 0, { width: 5 * s, passes: 2, bleed: true })
      ink.ellipse('stomp-heel', 0, 48 * s, 30 * s, 30 * s, 0, { width: 5 * s, passes: 2 })
      const sole = this.stompHit ? NOTEBOOK.ink : NOTEBOOK.inkSoft
      ink.fill([
        { x: -40 * s, y: -14 * s }, { x: 40 * s, y: -14 * s },
        { x: 32 * s, y: 40 * s }, { x: -32 * s, y: 40 * s }
      ], sole, 0.14)
      for (let i = 0; i < 4; i++) {
        const ty = -46 * s + i * 26 * s
        ink.line(`stomp-tread${i}`, -34 * s, ty, 34 * s, ty, { width: 3 * s, passes: 1, alpha: 0.6 })
      }
    })
    ink.ctx.restore()
  }

  /** A small squashed-bug tally so the player can see how many are left. */
  private drawTally(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = this.s
    const st = ink.stage
    const gap = 40 * s
    const x0 = st.cx - ((BUG_COUNT - 1) * gap) / 2
    const y = st.y + st.h * 0.055
    for (let i = 0; i < BUG_COUNT; i++) {
      const cx = x0 + i * gap
      const done = i < this.killed
      if (done) {
        // A tiny X for a squashed one.
        ink.line(`tallyx${i}a`, cx - 8 * s, y - 8 * s, cx + 8 * s, y + 8 * s, {
          color: NOTEBOOK.markerRed, width: 3 * s, passes: 1
        })
        ink.line(`tallyx${i}b`, cx + 8 * s, y - 8 * s, cx - 8 * s, y + 8 * s, {
          color: NOTEBOOK.markerRed, width: 3 * s, passes: 1
        })
      } else {
        // A little dot for a bug still loose.
        ink.fillCircle(cx, y, 6 * s, NOTEBOOK.ink, 0.85)
      }
    }
  }

  /** Dev-only view (GameScene's `__midnight.state().detail`) — bug positions so
   *  a scripted test can stomp them precisely. */
  debug() {
    return {
      killed: this.killed,
      bugs: this.bugs.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), dead: b.dead }))
    }
  }
}

export const bugStomp = (): MicroGame => new BugStomp()
