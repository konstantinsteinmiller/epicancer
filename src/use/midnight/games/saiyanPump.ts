// ─── Micro-game: Super Saiyan — "AAAAHRG!" ─────────────────────────────────
//
// vision-board-minigames §0. The kid stands in the middle of the page and
// SCREAMS. You mash the pump button; the power level climbs toward 9999 and
// bleeds away the moment you stop. Cross 9000 and the page detonates.
//
// ── What this game actually is ──
// Mechanically it's the simplest thing in the anthology: a button and a
// counter. Every single thing that makes it worth playing is what the page
// DOES while the number goes up — the hair, the aura, the debris, the cracks,
// the roar bending upward, the whole screen shaking itself apart. So the
// mechanic is ~40 lines and the rest of this file is spectacle, and that
// ratio is correct. It's a nostalgia machine: the joy is being the kid at 3AM
// who is, right now, going Super Saiyan.
//
// The escalation is layered deliberately — something new arrives at roughly
// every 20% of the bar (hair, aura, debris, speed lines, cracks, gold) so the
// climb never plateaus and the player always feels the next threshold coming.

import type { MicroGame, MicroGameCtx } from '../types'
import { NOTEBOOK, HIGHLIGHT } from '@/use/ink/palette'
import { mulberry32, range, makeRng } from '@/use/ink/rng'
import { saiyanRoar, powerClick, powerSurge, type Loop } from '@/use/ink/useInkAudio'
import { inkText } from '@/use/ink/strokeFont'
import type { Pt } from '@/use/ink/inkRenderer'

const MAX_POWER = 9999
/** The number. The only number. */
const OVER = 9000
/** Power added per pump. */
const CLICK_GAIN = 240
/** Power bled per second when the player isn't pumping. The spec says it
 *  "drops slowly" — slowly enough to be a threat, not a punishment: at this
 *  rate a full second of hesitation costs about one pump. */
const DECAY = 240

/** Ground debris torn up by the aura — the classic Dragon Ball Z tell that the
 *  power is affecting the WORLD, not just the character. */
interface Chunk {
  x: number
  y: number
  vx: number
  vy: number
  rot: number
  spin: number
  size: number
  life: number
}

class SaiyanPump implements MicroGame {
  readonly id = 'saiyan'
  readonly verbKey = 'game.saiyan.verb'
  readonly hintKey = 'game.saiyan.hint'
  /** The spec's 10 seconds. */
  readonly baseDuration = 10

  private power = 0
  private roar: Loop | null = null
  private rng: () => number = Math.random
  private chunks: Chunk[] = []
  /** Seconds since the last pump — drives the button's depress animation. */
  private sinceClick = 99
  /** Seconds since crossing 9000, or -1. Drives the OVER 9000 banner. */
  private overAt = -1
  private won = false
  /** Ground line + character anchor, in page units. */
  private groundY = 0
  private cx = 0
  /** Character scale module: everything is proportioned off this. */
  private s = 1
  private btn = { x: 0, y: 0, w: 0, h: 0 }
  private chunkAcc = 0

  init(ctx: MicroGameCtx, seed: number): void {
    const { ink } = ctx
    const st = ink.stage
    this.rng = mulberry32(seed)
    this.power = 0
    this.chunks = []
    this.sinceClick = 99
    this.overAt = -1
    this.won = false
    this.chunkAcc = 0

    this.cx = st.cx
    this.groundY = st.y + st.h * 0.72
    // Character scale. This is THE dial for the whole composition: at 0.0011
    // the kid was 14% of the stage and his own aura dwarfed him, which reads as
    // "a doodle with an effect on it" rather than "a person transforming". At
    // 0.0021 he's ~45% of the stage and the aura frames him instead of eating
    // him.
    this.s = st.w * 0.0021

    // A deliberately huge button. This is a mash game: the player's eyes are on
    // the character, not their cursor, and a small target would turn a game
    // about screaming into a game about aiming.
    this.btn.w = st.w * 0.56
    this.btn.h = st.h * 0.13
    this.btn.x = st.cx - this.btn.w / 2
    this.btn.y = st.y + st.h * 0.8

    this.roar?.stop()
    this.roar = saiyanRoar()
    this.roar?.setIntensity(0)
  }

  /** 0..1 of the way to the cap. The master dial for every visual below. */
  private get charge(): number {
    return Math.max(0, Math.min(1, this.power / MAX_POWER))
  }

  private get isOver(): boolean {
    return this.power >= OVER
  }

  update(ctx: MicroGameCtx, dt: number) {
    const { pointer, services } = ctx
    if (this.won) return undefined

    this.sinceClick += dt

    // Pump. Accepted ANYWHERE on the page, not just on the button — the button
    // is the affordance, but at 5 taps/second demanding the player also hit a
    // rectangle turns this into a precision test. The button still reacts to
    // every hit so the connection reads.
    if (pointer.pressed) {
      const wasOver = this.isOver
      this.power = Math.min(MAX_POWER, this.power + CLICK_GAIN)
      this.sinceClick = 0
      powerClick(this.charge)
      // Shake scales with the power: at the start it's a tap, by the end the
      // desk is coming apart.
      services.shake('tick', 0.6 + this.charge * 3.4)
      this.burstChunks(ctx, 2 + Math.floor(this.charge * 5))

      if (!wasOver && this.isOver) this.crossOver(services)
      if (this.power >= MAX_POWER) {
        this.won = true
        this.overAt = this.overAt < 0 ? 0 : this.overAt
        powerSurge()
        services.shake('slam', 1.6)
        services.impactFrame(4)
        return 'won'
      }
    } else {
      this.power = Math.max(0, this.power - DECAY * dt)
    }

    if (this.overAt >= 0) this.overAt += dt
    this.roar?.setIntensity(this.charge)

    // The aura tears debris off the ground continuously once it's strong.
    this.chunkAcc += dt * this.charge * 26
    if (this.chunkAcc >= 1) {
      this.chunkAcc = 0
      this.burstChunks(ctx, 1)
    }
    this.stepChunks(dt)

    // Timeout is the core loop's job, but the WIN threshold is ours: the spec
    // loses only if the player "stays below 9000", so anything at or past the
    // number is a clear — 9999 is simply the early, perfect finish.
    if (ctx.remaining <= 0.0001 && this.isOver) return 'won'
    return undefined
  }

  private crossOver(services: MicroGameCtx['services']): void {
    this.overAt = 0
    powerSurge()
    services.shake('slam', 1.3)
    // The one moment in the whole game that has earned a 4-frame invert.
    services.impactFrame(4)
  }

  private burstChunks(ctx: MicroGameCtx, n: number): void {
    const { ink } = ctx
    for (let i = 0; i < n; i++) {
      if (this.chunks.length > 60) break
      const rng = this.rng
      this.chunks.push({
        x: this.cx + range(rng, -1, 1) * ink.stage.w * 0.28,
        y: this.groundY + range(rng, -6, 10) * this.s,
        vx: range(rng, -60, 60) * this.s,
        // Debris flies UP, hard — that's the DBZ read. Gravity brings it back.
        vy: range(rng, -600, -280) * this.s * (0.5 + this.charge),
        rot: range(rng, 0, Math.PI * 2),
        spin: range(rng, -7, 7),
        size: range(rng, 4, 13) * this.s,
        life: 0
      })
    }
  }

  private stepChunks(dt: number): void {
    for (const c of this.chunks) {
      c.life += dt
      c.vy += 900 * this.s * dt
      c.x += c.vx * dt
      c.y += c.vy * dt
      c.rot += c.spin * dt
    }
    this.chunks = this.chunks.filter((c) => c.life < 2 && c.y < this.groundY + 60 * this.s)
  }

  // ── Draw ────────────────────────────────────────────────────────────────

  draw(ctx: MicroGameCtx): void {
    this.drawSpeedLines(ctx)
    this.drawCracks(ctx)
    this.drawGround(ctx)
    this.drawAura(ctx)
    this.drawChunks(ctx)
    this.drawCharacter(ctx)
    this.drawEnergyLines(ctx)
    this.drawReadout(ctx)
    this.drawButton(ctx)
    this.drawOverBanner(ctx)
  }

  drawOutcome(ctx: MicroGameCtx, outcome: 'won' | 'lost', since: number): void {
    const { ink } = ctx
    if (outcome === 'won') {
      // Hold the transformation at full blast and let the aura bloom outward.
      this.drawSpeedLines(ctx, 1)
      this.drawCracks(ctx, 1)
      this.drawGround(ctx)
      this.drawAura(ctx, 1 + since * 0.5)
      this.drawChunks(ctx)
      this.drawCharacter(ctx, 1)
      this.drawEnergyLines(ctx, 1)
      // A white-hot shockwave ring blasting out.
      const r = since * ink.stage.w * 1.4
      if (since < 1) {
        ink.circle('shock', this.cx, this.groundY - 120 * this.s, r, {
          color: HIGHLIGHT.yellow,
          width: 30 * this.s * (1 - since),
          passes: 1,
          alpha: Math.max(0, 1 - since),
          rough: 8
        })
      }
      this.drawReadout(ctx)
    } else {
      // The power collapses. The kid deflates — no aura, no hair, no debris,
      // just a tired teenager who didn't make it. The absence IS the joke.
      this.drawGround(ctx)
      this.drawCharacter(ctx, 0, true)
      this.drawReadout(ctx)
    }
  }

  /** Radial speed lines rushing inward — the page itself reacting. */
  private drawSpeedLines(ctx: MicroGameCtx, force?: number): void {
    const { ink } = ctx
    const c = force ?? this.charge
    if (c < 0.18) return
    const rng = makeRng('speed', ink.boil)
    const count = Math.floor(10 + c * 26)
    const cy = this.groundY - 150 * this.s
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + range(rng, -0.08, 0.08)
      const r0 = ink.stage.w * range(rng, 0.3, 0.45)
      const r1 = r0 + ink.stage.w * range(rng, 0.16, 0.4) * c
      ink.stroke(`speed${i}`, [
        { x: this.cx + Math.cos(a) * r0, y: cy + Math.sin(a) * r0 },
        { x: this.cx + Math.cos(a) * r1, y: cy + Math.sin(a) * r1 }
      ], {
        color: NOTEBOOK.inkSoft,
        width: 3 * this.s,
        passes: 1,
        alpha: 0.15 + c * 0.4,
        rough: 3
      })
    }
  }

  /** The page splitting under the character's feet. */
  private drawCracks(ctx: MicroGameCtx, force?: number): void {
    const { ink } = ctx
    const c = force ?? this.charge
    if (c < 0.62) return
    const grow = (c - 0.62) / 0.38
    const rng = makeRng('crack', 0)
    for (let i = 0; i < 5; i++) {
      const a = Math.PI * range(rng, 0.05, 0.95)
      const pts: Pt[] = [{ x: this.cx, y: this.groundY }]
      let px = this.cx
      let py = this.groundY
      const steps = 5
      for (let s = 0; s < steps; s++) {
        const len = ink.stage.w * 0.09 * grow
        px += Math.cos(a) * len + range(rng, -14, 14) * this.s
        py += Math.sin(a) * len * 0.35 + range(rng, -8, 8) * this.s
        pts.push({ x: px, y: py })
      }
      ink.stroke(`crack${i}`, pts, {
        color: NOTEBOOK.ink,
        width: (5 + grow * 5) * this.s,
        passes: 1,
        alpha: grow,
        rough: 5
      })
    }
  }

  private drawGround(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const st = ink.stage
    ink.stroke('ground', [
      { x: st.x - 20, y: this.groundY },
      { x: st.cx, y: this.groundY + 4 * this.s },
      { x: st.x + st.w + 20, y: this.groundY }
    ], { width: 5 * this.s, passes: 2, bleed: true })
  }

  /**
   * The aura: a licking flame envelope around the body.
   *
   * Built as a closed polygon whose radius wobbles per-vertex, re-seeded on the
   * boil — so it flickers between three shapes at 12fps exactly like real
   * hand-inked fire, rather than smoothly morphing (which would look like a
   * shader and break the whole conceit).
   */
  private drawAura(ctx: MicroGameCtx, force?: number): void {
    const { ink } = ctx
    const c = force ?? this.charge
    if (c < 0.06) return
    const cy = this.groundY - 130 * this.s
    const rng = makeRng('aura', ink.boil)
    const w = (70 + c * 90) * this.s
    const h = (150 + c * 280) * this.s

    const pts: Pt[] = []
    const steps = 22
    for (let i = 0; i <= steps; i++) {
      const f = i / steps
      const a = -Math.PI / 2 + f * Math.PI * 2
      // Flames reach UP: stretch the envelope along -y, and spike it hardest
      // near the top.
      const up = Math.max(0, -Math.sin(a))
      // Alternating long/short tongues, not uniform noise — that's what makes
      // a silhouette read as fire rather than as a lumpy balloon.
      const tongue = i % 2 === 0 ? range(rng, 1.05, 1.5) : range(rng, 0.62, 0.85)
      const spike = tongue * (1 + up * 1.35)
      pts.push({
        x: this.cx + Math.cos(a) * w * range(rng, 0.85, 1.15),
        y: cy + Math.sin(a) * h * 0.5 * spike - up * h * 0.34
      })
    }
    // Multiply-blended fill so the linework underneath still reads through it.
    ink.ctx.save()
    ink.ctx.globalCompositeOperation = 'multiply'
    ink.fill(pts, this.isOver ? HIGHLIGHT.yellow : HIGHLIGHT.orange, 0.24 + c * 0.4)
    ink.ctx.restore()
    ink.stroke('aura', pts, {
      color: this.isOver ? HIGHLIGHT.yellow : HIGHLIGHT.orange,
      width: (4 + c * 5) * this.s,
      passes: 1,
      close: true,
      alpha: 0.6 + c * 0.4,
      rough: 7
    })

    // A white-hot core once it's over the number.
    if (this.isOver) {
      const core: Pt[] = pts.map((p) => ({
        x: this.cx + (p.x - this.cx) * 0.55,
        y: cy + (p.y - cy) * 0.6
      }))
      ink.ctx.save()
      ink.ctx.globalCompositeOperation = 'screen'
      ink.fill(core, '#fffbe0', 0.5)
      ink.ctx.restore()
    }
  }

  private drawChunks(ctx: MicroGameCtx): void {
    const { ink } = ctx
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i]!
      ink.transformed(c.x, c.y, c.rot, 1, () => {
        ink.shape(`chunk${i}`, [
          { x: -c.size, y: -c.size * 0.6 },
          { x: c.size * 0.7, y: -c.size },
          { x: c.size, y: c.size * 0.5 },
          { x: -c.size * 0.4, y: c.size }
        ], { width: 2.2 * this.s, passes: 1, alpha: 0.85 })
      })
    }
  }

  /** Jagged energy bolts flying off the body. */
  private drawEnergyLines(ctx: MicroGameCtx, force?: number): void {
    const { ink } = ctx
    const c = force ?? this.charge
    if (c < 0.3) return
    const rng = makeRng('energy', ink.boil)
    const cy = this.groundY - 150 * this.s
    const count = Math.floor(3 + c * 9)
    for (let i = 0; i < count; i++) {
      const a = range(rng, 0, Math.PI * 2)
      const r0 = (80 + c * 40) * this.s
      const pts: Pt[] = []
      let px = this.cx + Math.cos(a) * r0
      let py = cy + Math.sin(a) * r0
      pts.push({ x: px, y: py })
      // A crackling bolt: three jagged hops outward.
      for (let s = 0; s < 3; s++) {
        px += Math.cos(a) * 34 * this.s + range(rng, -22, 22) * this.s
        py += Math.sin(a) * 34 * this.s + range(rng, -22, 22) * this.s
        pts.push({ x: px, y: py })
      }
      ink.stroke(`energy${i}`, pts, {
        color: this.isOver ? '#fff3c4' : HIGHLIGHT.yellow,
        width: 4 * this.s,
        passes: 1,
        alpha: 0.75 + c * 0.25,
        rough: 4
      })
    }
  }

  /**
   * The kid, mid-transformation. Power drives the hair, the eyes, the tremor
   * and the stance.
   */
  private drawCharacter(ctx: MicroGameCtx, force?: number, defeated = false): void {
    const { ink, t } = ctx
    const c = force ?? this.charge
    const s = this.s
    const cy = this.groundY
    // The whole body trembles harder as the power climbs.
    const rng = makeRng('body', ink.boil)
    const shakeX = defeated ? 0 : range(rng, -1, 1) * 5 * s * c
    const x = this.cx + shakeX
    const ink1 = { width: 6 * s, passes: 2 } as const

    if (defeated) {
      // Slumped: head down, arms hanging.
      ink.circle('sy-head', x, cy - 150 * s, 42 * s, ink1)
      ink.stroke('sy-body', [{ x, y: cy - 108 * s }, { x, y: cy - 20 * s }], ink1)
      ink.stroke('sy-arm1', [{ x, y: cy - 96 * s }, { x: x - 40 * s, y: cy - 24 * s }], ink1)
      ink.stroke('sy-arm2', [{ x, y: cy - 96 * s }, { x: x + 40 * s, y: cy - 24 * s }], ink1)
      ink.stroke('sy-leg1', [{ x, y: cy - 20 * s }, { x: x - 30 * s, y: cy }], ink1)
      ink.stroke('sy-leg2', [{ x, y: cy - 20 * s }, { x: x + 30 * s, y: cy }], ink1)
      // Defeated face: flat eyes, flat mouth.
      for (let i = 0; i < 2; i++) {
        const ex = x + (i === 0 ? -14 : 14) * s
        ink.stroke(`sy-eye${i}`, [
          { x: ex - 8 * s, y: cy - 156 * s }, { x: ex + 8 * s, y: cy - 156 * s }
        ], { width: 3 * s, passes: 1 })
      }
      ink.stroke('sy-mouth', [
        { x: x - 14 * s, y: cy - 130 * s }, { x: x + 14 * s, y: cy - 130 * s }
      ], { width: 3.4 * s, passes: 1 })
      return
    }

    // ── Power stance: knees bent, fists down and out, body braced. ──
    // Deepens with the charge, so the kid visibly digs in as it builds.
    const crouch = 12 * s * c
    const hipY = cy - 40 * s + crouch
    const shoulderY = cy - 128 * s + crouch
    const headY = cy - 172 * s + crouch
    const spread = 1 + c * 0.25

    ink.stroke('sy-leg1', [
      { x, y: hipY },
      { x: x - 34 * s * spread, y: cy - 22 * s },
      { x: x - 44 * s * spread, y: cy }
    ], ink1)
    ink.stroke('sy-leg2', [
      { x, y: hipY },
      { x: x + 34 * s * spread, y: cy - 22 * s },
      { x: x + 44 * s * spread, y: cy }
    ], ink1)
    ink.stroke('sy-body', [{ x, y: shoulderY }, { x: x - 2 * s, y: hipY }], ink1)

    // Arms braced downward-out, fists clenched.
    for (let i = 0; i < 2; i++) {
      const dir = i === 0 ? -1 : 1
      const fx = x + dir * (56 + c * 16) * s
      const fy = hipY - 6 * s
      ink.stroke(`sy-arm${i}`, [
        { x: x + dir * 8 * s, y: shoulderY + 6 * s },
        { x: x + dir * (48 + c * 10) * s, y: shoulderY + 46 * s },
        { x: fx, y: fy }
      ], ink1)
      // Fist.
      ink.circle(`sy-fist${i}`, fx, fy, 13 * s, { width: 4.5 * s, passes: 2 })
    }

    // ── Hair. The headline visual. ──
    //
    // Drawn as a filled SILHOUETTE behind the head, not as strokes over it.
    // Stroking a zigzag of spikes across the skull merges hair and face into
    // one illegible black mass — which is exactly what it did on the first
    // pass. A closed polygon (base → tip → base → …) filled and outlined, with
    // the head painted opaque on top of it, gives clean spikes and a readable
    // face. Over 9000 the mass turns gold: the whole silhouette the memory is
    // built from.
    const gold = this.isOver
    const spikes = 7
    // The biggest range of any element: a sensible tuft at rest, absurd by the
    // end.
    const hairLen = (14 + c * 132) * s
    const hairPts: Pt[] = []
    for (let i = 0; i <= spikes; i++) {
      const f = i / spikes
      // Bases sit around the upper skull, from just below the left ear round to
      // just below the right — so the fill tucks behind the head cleanly.
      const a = Math.PI * (1.12 - f * 1.24)
      const baseX = x + Math.cos(a) * 42 * s
      const baseY = headY + Math.sin(a) * 42 * s
      hairPts.push({ x: baseX, y: baseY })
      if (i === spikes) break
      // Spikes fan outward from centre and reach UP. The middle ones are the
      // longest, which is what gives the classic flame-shaped crown.
      const centreBias = 1 - Math.abs(f - 0.5) * 1.1
      const lean = (f - 0.5) * 2.1
      const tipX = baseX + lean * 30 * s * (0.4 + c)
      const tipY = baseY - hairLen * (0.55 + centreBias * 0.7)
        * range(makeRng(`hair${i}`, ink.boil), 0.85, 1.15)
      hairPts.push({ x: tipX, y: tipY })
    }
    ink.fill(hairPts, gold ? HIGHLIGHT.yellow : NOTEBOOK.ink, gold ? 0.95 : 0.9)
    ink.stroke('sy-hair', hairPts, {
      color: gold ? '#b58900' : NOTEBOOK.ink,
      width: 4 * s,
      passes: 1,
      close: true
    })

    // ── Head, painted OVER the hair's roots so the face stays readable. ──
    ink.fillCircle(x, headY, 42 * s, NOTEBOOK.paper, 1)
    ink.circle('sy-head', x, headY, 42 * s, ink1)

    // ── Face: eyes and a wide-open scream. ──
    const glow = gold ? 1 : 0.35 + c * 0.5
    for (let i = 0; i < 2; i++) {
      const ex = x + (i === 0 ? -16 : 16) * s
      const ey = headY - 12 * s
      // Eyes go from normal dots to blazing red as the power climbs.
      ink.fillCircle(ex, ey, (6 + c * 3) * s, NOTEBOOK.markerRed, glow)
      ink.circle(`sy-eye${i}`, ex, ey, (6 + c * 3) * s, { width: 2.6 * s, passes: 1 })
      // Angry brow, driven down toward the eye as the power climbs.
      ink.stroke(`sy-brow${i}`, [
        { x: ex - (i === 0 ? 13 : -13) * s, y: ey - 18 * s },
        { x: ex + (i === 0 ? 11 : -11) * s, y: ey - (10 - c * 3) * s }
      ], { width: 4 * s, passes: 1 })
    }
    // The scream: an open mouth that gapes wider with power. Sized to leave the
    // head readable — a mouth that fills the skull just looks like a blot.
    const mouthW = (11 + c * 9) * s
    const mouthH = (8 + c * 16) * s
    const mouth: Pt[] = []
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * Math.PI * 2
      mouth.push({ x: x + Math.cos(a) * mouthW, y: headY + 22 * s + Math.sin(a) * mouthH })
    }
    ink.fill(mouth, NOTEBOOK.ink, 0.85)
    ink.stroke('sy-mouth', mouth, { width: 4 * s, passes: 1, close: true })
  }

  /** The scouter readout: the power level, hand-scrawled, huge. */
  private drawReadout(ctx: MicroGameCtx): void {
    const { ink, t } = ctx
    const st = ink.stage
    const shown = Math.floor(this.power)
    const over = this.isOver
    // It jitters and swells as it climbs — a number that can barely contain
    // itself.
    const pulse = over ? 1 + Math.sin(t * 22) * 0.06 : 1
    inkText(ink, 'sy-power', String(shown), st.cx, st.y + st.h * 0.105, st.w * 0.13 * pulse, {
      align: 'center',
      baseline: 'middle',
      color: over ? NOTEBOOK.markerRed : NOTEBOOK.ink,
      width: st.w * 0.016,
      bleed: true,
      tilt: over ? 0.1 : 0.04,
      scatter: over ? 0.05 : 0.02
    })
    // A power bar under the number: a scrawled gauge that fills.
    const bw = st.w * 0.62
    const bx = st.cx - bw / 2
    const by = st.y + st.h * 0.16
    const bh = st.h * 0.022
    ink.rect('sy-bar', bx, by, bw, bh, { width: 3 * this.s, passes: 1 })
    if (this.charge > 0.01) {
      ink.ctx.save()
      ink.ctx.beginPath()
      ink.ctx.rect(bx, by, bw * this.charge, bh)
      ink.ctx.clip()
      ink.fill([
        { x: bx, y: by }, { x: bx + bw, y: by },
        { x: bx + bw, y: by + bh }, { x: bx, y: by + bh }
      ], over ? HIGHLIGHT.yellow : HIGHLIGHT.orange, 0.9)
      ink.ctx.restore()
    }
    // The 9000 threshold, marked on the gauge so the goal is legible.
    const tx = bx + bw * (OVER / MAX_POWER)
    ink.line('sy-thresh', tx, by - bh * 0.5, tx, by + bh * 1.5, {
      color: NOTEBOOK.markerRed, width: 3 * this.s, passes: 1
    })
  }

  private drawButton(ctx: MicroGameCtx): void {
    const { ink, t, services } = ctx
    const { x, y, w, h } = this.btn
    // Depress for ~90ms after each hit, so the button physically answers every
    // mash. Without this the player is hammering a picture.
    const press = Math.max(0, 1 - this.sinceClick / 0.09)
    const squash = 1 - press * 0.1
    const cy = y + h / 2 + press * h * 0.06

    ink.transformed(x + w / 2, cy, 0, 1, () => {
      // Shadow plate underneath, revealed as the button sinks.
      ink.roundRect('sy-btn-base', -w / 2, -h / 2 + h * 0.06, w, h, h * 0.3, {
        color: NOTEBOOK.inkSoft, width: 4 * this.s, passes: 1, alpha: 0.5
      })
      ink.highlightBlob('sy-btn-hl', 0, 0, w * 0.33, 'yellow', 0.25 + press * 0.45)
      ink.roundRect('sy-btn', -w / 2, (-h / 2) * squash, w, h * squash, h * 0.3, {
        width: 6 * this.s, passes: 2, bleed: true
      })
      inkText(ink, 'sy-btn-label', services.t('game.saiyan.pump'), 0, 0, h * 0.44, {
        align: 'center',
        baseline: 'middle',
        color: NOTEBOOK.ink,
        width: h * 0.06,
        tilt: 0.05
      })
    })
  }

  /** "IT'S OVER 9000!" — slams in, then flies up off the page. */
  private drawOverBanner(ctx: MicroGameCtx): void {
    const { ink, services } = ctx
    if (this.overAt < 0) return
    const a = this.overAt
    const st = ink.stage
    // Punch in over 0.16s, hold, then launch upward and away.
    const pop = Math.min(1, a / 0.16)
    const fly = Math.max(0, a - 0.9)
    const y = st.y + st.h * 0.36 - fly * fly * st.h * 2.4
    const alpha = Math.max(0, 1 - fly * 0.9)
    if (alpha <= 0) return
    const scale = (2.4 - 1.4 * pop) * (1 + fly * 0.3)

    ink.ctx.save()
    ink.ctx.globalAlpha = alpha
    ink.transformed(st.cx, y, -0.06, scale, () => {
      inkText(ink, 'sy-over', services.t('game.saiyan.over'), 0, 0, st.w * 0.085, {
        align: 'center',
        baseline: 'middle',
        color: NOTEBOOK.markerRed,
        width: st.w * 0.012,
        bleed: true,
        tilt: 0.1,
        scatter: 0.05
      })
    })
    ink.ctx.restore()
  }

  dispose(): void {
    this.roar?.stop()
    this.roar = null
  }
}

export const saiyanPump = (): MicroGame => new SaiyanPump()
