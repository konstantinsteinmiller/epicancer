// ─── Boss: "TUNE IT!" — Find The Signal ────────────────────────────────────
//
// GDD §4.4 / vision-board panel 7: the avatar on a jagged pencil roof under a
// charcoal starry sky, holding a Yagi antenna. The page is buried under dense
// grey cross-hatched pencil shading standing in for analog TV static. Rotate
// the antenna to the hidden hotspot angle, then hold still while an ink-tube
// progress bar fills.
//
// ── On rotation input ──
// The GDD asks the player to "move the mouse in a wide circular pattern".
// Tracking a literal circular gesture is hostile on a phone (no room to
// circle) and ambiguous with a mouse (what counts as circular?). So the
// antenna simply aims at the pointer: the ANGLE from the avatar to your finger
// is the antenna's angle. Sweeping to find the hotspot still produces exactly
// the arc-shaped motion the GDD describes, and it works identically with a
// thumb on a 320px screen.
//
// ── On the static veil ──
// A full-page cross-hatch is the most expensive thing in the game — thousands
// of strokes. Drawing it live at 12fps would blow the frame budget on a phone.
// It's baked ONCE into an offscreen canvas at init and then blitted with a
// varying alpha, which turns per-frame cost into a single drawImage. See
// `bakeVeil`.

import type { MicroGame, MicroGameCtx } from '../types'
import { NOTEBOOK, HIGHLIGHT } from '@/use/ink/palette'
import { mulberry32, range, makeRng } from '@/use/ink/rng'
import { tvStatic, retroMelody, chime, type Loop } from '@/use/ink/useInkAudio'
import { InkRenderer, type Pt } from '@/use/ink/inkRenderer'
import { inkText } from '@/use/ink/strokeFont'

/** How close to the hotspot counts as "locked", in radians. */
const LOCK_ARC = 0.2
/** How wide the signal starts bleeding through, in radians. Static fades
 *  smoothly across this band — that gradient IS the player's only clue. */
const FALLOFF = 1.0
/** GDD §4.4: "hold still for 3 seconds while a progress bar charges up". */
const CHARGE_S = 3
/** GDD §4.4: "an extended, 20-second multi-phase encounter". */
const DURATION = 20

class FindSignal implements MicroGame {
  readonly id = 'signal'
  readonly verbKey = 'game.signal.verb'
  readonly hintKey = 'game.signal.hint'
  readonly baseDuration = DURATION
  readonly isBoss = true

  private hotspot = 0
  private angle = 0
  private charge = 0
  private locked = false
  private won = false
  private staticLoop: Loop | null = null
  private melodyLoop: Loop | null = null
  private rng: () => number = Math.random
  private avatar: Pt = { x: 0, y: 0 }
  private veil: HTMLCanvasElement | null = null
  private veilKey = ''

  init(ctx: MicroGameCtx, seed: number): void {
    const { ink } = ctx
    this.rng = mulberry32(seed)
    // "Randomised each run" — but kept out of the top quadrant, where the
    // antenna would occlude the avatar and the player couldn't see the aim.
    this.hotspot = range(this.rng, -Math.PI * 0.85, -Math.PI * 0.15)
    this.angle = this.hotspot + (this.rng() < 0.5 ? -1 : 1) * range(this.rng, 1.1, 2.0)
    this.charge = 0
    this.locked = false
    this.won = false
    // The sky bleeds to the page edges, but the avatar + antenna live in the
    // stage box so the aiming sweep stays within thumb reach on a phone.
    const st = ink.stage
    this.avatar = { x: st.cx, y: st.y + st.h * 0.7 }

    this.staticLoop?.stop()
    this.melodyLoop?.stop()
    this.staticLoop = tvStatic()
    this.melodyLoop = retroMelody()
    this.staticLoop?.setIntensity(1)
    this.melodyLoop?.setIntensity(0)
  }

  /** 0..1 — how close the antenna is to the hotspot. 1 = dead on. */
  private get signal(): number {
    let d = Math.abs(this.normalize(this.angle - this.hotspot))
    if (d <= LOCK_ARC) return 1
    const f = 1 - (d - LOCK_ARC) / FALLOFF
    return Math.max(0, Math.min(1, f))
  }

  private normalize(a: number): number {
    while (a > Math.PI) a -= Math.PI * 2
    while (a < -Math.PI) a += Math.PI * 2
    return a
  }

  update(ctx: MicroGameCtx, dt: number) {
    const { pointer, services } = ctx
    if (this.won) return undefined

    if (pointer.seen) {
      // Aim at the pointer. Smoothed rather than snapped: an antenna has
      // weight, and instant tracking would let the player scrub the whole arc
      // in one frame and brute-force the hotspot.
      const target = Math.atan2(pointer.y - this.avatar.y, pointer.x - this.avatar.x)
      const delta = this.normalize(target - this.angle)
      this.angle += delta * Math.min(1, dt * 7)
    }

    const sig = this.signal
    this.locked = sig >= 1

    this.staticLoop?.setIntensity(1 - sig * 0.92)
    this.melodyLoop?.setIntensity(sig)

    if (this.locked) {
      this.charge += dt
      if (this.charge >= CHARGE_S) {
        this.won = true
        chime(4)
        services.shake('slam')
        services.impactFrame(3)
        return 'won'
      }
    } else {
      // Drain rather than reset: a momentary wobble off the hotspot shouldn't
      // erase three seconds of holding still. Drains at half the fill rate, so
      // drifting still costs — it just doesn't punish a twitch.
      this.charge = Math.max(0, this.charge - dt * 0.5)
    }
    return undefined
  }

  /** Dev-only view (GameScene's `__midnight.state().detail`). The boss is aimed
   *  rather than tapped, so its state is invisible in a screenshot: `signal` is
   *  the gradient the player hears as static, and `charge` is the hold. Exposing
   *  the hotspot lets an automated session verify the lock actually completes. */
  debug() {
    return {
      signal: Math.round(this.signal * 100) / 100,
      charge: Math.round(this.charge * 100) / 100,
      locked: this.locked,
      angle: this.angle,
      hotspot: this.hotspot,
      avatar: { x: Math.round(this.avatar.x), y: Math.round(this.avatar.y) }
    }
  }

  draw(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const sig = this.signal

    this.drawSky(ctx, sig)
    this.drawRoof(ctx)
    this.drawAvatar(ctx)
    this.drawAntenna(ctx)
    this.drawVeil(ctx, 1 - sig)
    this.drawChargeTube(ctx)
  }

  drawOutcome(ctx: MicroGameCtx, outcome: 'won' | 'lost', since: number): void {
    const { ink } = ctx
    if (outcome === 'won') {
      // "The static vanishes completely, revealing a beautifully vibrant,
      // coloured marker drawing of a clear morning sky" (GDD §4.4).
      this.drawMorningSky(ctx, Math.min(1, since * 1.4))
      this.drawRoof(ctx)
      this.drawAvatar(ctx, true)
      this.drawAntenna(ctx)
    } else {
      // "A bolt of highlighter-yellow lightning cuts across the page, ripping
      // it in half" (GDD §4.4).
      this.drawSky(ctx, 0)
      this.drawRoof(ctx)
      this.drawAvatar(ctx)
      this.drawAntenna(ctx)
      this.drawVeil(ctx, 1)
      this.drawLightning(ctx, Math.min(1, since * 3))
    }
  }

  /** The charcoal starry night. As the signal locks, colour bleeds back in. */
  private drawSky(ctx: MicroGameCtx, sig: number): void {
    const { ink } = ctx
    const g = ink.ctx.createLinearGradient(0, 0, 0, ink.ph)
    // Mix from cold charcoal toward a hint of night blue as the signal comes
    // in — the reward starts before the win does.
    g.addColorStop(0, sig > 0.5 ? '#2b3a5c' : '#2a2a30')
    g.addColorStop(1, sig > 0.5 ? '#4a5a7c' : '#4a4a52')
    ink.ctx.save()
    ink.ctx.globalAlpha = 0.9
    ink.ctx.fillStyle = g
    ink.ctx.fillRect(0, 0, ink.pw, ink.ph)
    ink.ctx.restore()

    // Stars + a moon, scratched in white pencil.
    const rng = makeRng('stars', 0)
    for (let i = 0; i < 40; i++) {
      const x = range(rng, 0, ink.pw)
      const y = range(rng, 0, ink.ph * 0.62)
      ink.fillCircle(x, y, ink.u(range(rng, 1.2, 3)), '#ffffff', range(rng, 0.3, 0.9))
    }
    ink.circle('moon', ink.pw * 0.78, ink.ph * 0.14, ink.u(42), {
      color: '#ffffff', width: ink.u(3), passes: 1, alpha: 0.8
    })
    // Swirling charcoal cloud strokes, as in the reference panel.
    for (let i = 0; i < 5; i++) {
      const y = ink.ph * (0.08 + i * 0.1)
      const pts: Pt[] = []
      for (let s = 0; s <= 10; s++) {
        pts.push({
          x: (s / 10) * ink.pw,
          y: y + Math.sin(s * 0.9 + i) * ink.u(18)
        })
      }
      ink.stroke(`cloud${i}`, pts, {
        color: '#ffffff', width: ink.u(2.4), passes: 1, alpha: 0.16, rough: 6
      })
    }
  }

  private drawMorningSky(ctx: MicroGameCtx, p: number): void {
    const { ink } = ctx
    const g = ink.ctx.createLinearGradient(0, 0, 0, ink.ph)
    g.addColorStop(0, '#7fb4e8')
    g.addColorStop(0.6, '#ffd39a')
    g.addColorStop(1, '#ffb27a')
    ink.ctx.save()
    ink.ctx.globalAlpha = p
    ink.ctx.fillStyle = g
    ink.ctx.fillRect(0, 0, ink.pw, ink.ph)
    ink.ctx.restore()

    // The sun, in vivid marker.
    const sx = ink.pw * 0.74
    const sy = ink.ph * 0.2
    ink.fillCircle(sx, sy, ink.u(52) * p, '#fff3c4', 0.95)
    ink.circle('sun', sx, sy, ink.u(52) * p, { color: HIGHLIGHT.orange, width: ink.u(5), passes: 2 })
    ink.actionLines('sunrays', sx, sy, ink.u(64), ink.u(64) + p * ink.u(60), 12, HIGHLIGHT.orange)
  }

  /** The jagged pencil roof the avatar stands on. */
  private drawRoof(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const st = ink.stage
    const y = st.y + st.h * 0.72
    const pts: Pt[] = [
      { x: -ink.u(20), y: y + ink.u(60) },
      { x: ink.pw * 0.3, y },
      { x: ink.pw * 0.7, y: y + ink.u(14) },
      { x: ink.pw + ink.u(20), y: y + ink.u(50) },
      { x: ink.pw + ink.u(20), y: ink.ph + ink.u(20) },
      { x: -ink.u(20), y: ink.ph + ink.u(20) }
    ]
    ink.fill(pts, '#3a3a42', 0.95)
    ink.shape('roof', pts, { color: '#ffffff', width: ink.u(3.4), passes: 1, alpha: 0.6 })
    // Shingle rows.
    for (let i = 0; i < 5; i++) {
      const ry = y + ink.u(50) + i * ink.u(34)
      ink.line(`shingle${i}`, 0, ry, ink.pw, ry + ink.u(8), {
        color: '#ffffff', width: ink.u(1.6), passes: 1, alpha: 0.2, rough: 3
      })
    }
  }

  /** The tired kid with messy hair and eye bags (vision-board panel 2). */
  private drawAvatar(ctx: MicroGameCtx, happy = false): void {
    const { ink, t } = ctx
    const { x, y } = this.avatar
    const s = ink.u(1)
    const white = '#ffffff'
    const line = { color: white, width: ink.u(3.2), passes: 2 } as const

    // Body.
    ink.stroke('av-body', [
      { x, y: y - 60 * s }, { x, y: y + 10 * s }
    ], line)
    // Legs.
    ink.stroke('av-leg1', [{ x, y: y + 10 * s }, { x: x - 22 * s, y: y + 60 * s }], line)
    ink.stroke('av-leg2', [{ x, y: y + 10 * s }, { x: x + 20 * s, y: y + 60 * s }], line)
    // The arm holding the antenna reaches toward its angle.
    const ax = x + Math.cos(this.angle) * 46 * s
    const ay = y - 44 * s + Math.sin(this.angle) * 30 * s
    ink.stroke('av-arm1', [{ x, y: y - 46 * s }, { x: ax, y: ay }], line)
    ink.stroke('av-arm2', [
      { x, y: y - 44 * s }, { x: x - 34 * s, y: y - 10 * s }
    ], line)
    // Head.
    ink.circle('av-head', x, y - 82 * s, 24 * s, line)
    // Messy hair.
    const rng = makeRng('av-hair', ink.boil)
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI * 0.9 + (i / 6) * Math.PI * 0.8
      const hx = x + Math.cos(a) * 24 * s
      const hy = y - 82 * s + Math.sin(a) * 24 * s
      ink.stroke(`av-hair${i}`, [
        { x: hx, y: hy },
        { x: hx + Math.cos(a) * range(rng, 8, 18) * s, y: hy + Math.sin(a) * range(rng, 8, 18) * s }
      ], { color: white, width: ink.u(2.4), passes: 1, rough: 2 })
    }
    // Eyes — wide, with the eye bags that are this character's whole identity.
    for (let i = 0; i < 2; i++) {
      const ex = x + (i === 0 ? -9 : 9) * s
      const ey = y - 84 * s
      ink.circle(`av-eye${i}`, ex, ey, 5.5 * s, { color: white, width: ink.u(2), passes: 1 })
      ink.fillCircle(ex, ey, 2.6 * s, white)
      ink.stroke(`av-bag${i}`, [
        { x: ex - 6 * s, y: ey + 8 * s }, { x: ex + 6 * s, y: ey + 8 * s }
      ], { color: white, width: ink.u(1.6), passes: 1, alpha: 0.7 })
    }
    // Mouth.
    if (happy) {
      const pts: Pt[] = []
      for (let i = 0; i <= 6; i++) {
        const a = Math.PI * (0.15 + (i / 6) * 0.7)
        pts.push({ x: x + Math.cos(a) * 11 * s, y: y - 72 * s + Math.sin(a) * 9 * s })
      }
      ink.stroke('av-mouth', pts, { color: white, width: ink.u(2.2), passes: 1 })
    } else {
      ink.stroke('av-mouth', [
        { x: x - 7 * s, y: y - 70 * s }, { x: x + 7 * s, y: y - 70 * s }
      ], { color: white, width: ink.u(2.2), passes: 1 })
    }
  }

  /** The Yagi: a boom with crossbar elements, rotating about the avatar's hand. */
  private drawAntenna(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const s = ink.u(1)
    const hx = this.avatar.x + Math.cos(this.angle) * 46 * s
    const hy = this.avatar.y - 44 * s + Math.sin(this.angle) * 30 * s
    const sig = this.signal
    // The boom glows as the signal comes in — the aim feedback that makes the
    // sweep legible.
    const col = sig > 0.99 ? HIGHLIGHT.green : sig > 0.4 ? HIGHLIGHT.yellow : '#ffffff'

    ink.ctx.save()
    ink.ctx.translate(hx, hy)
    ink.ctx.rotate(this.angle)

    const len = 150 * s
    ink.stroke('yagi-boom', [{ x: 0, y: 0 }, { x: len, y: 0 }], {
      color: col, width: ink.u(4), passes: 2
    })
    // Elements, shortening toward the tip.
    for (let i = 0; i < 5; i++) {
      const bx = 34 * s + i * 26 * s
      const half = (44 - i * 6) * s
      ink.stroke(`yagi-el${i}`, [{ x: bx, y: -half }, { x: bx, y: half }], {
        color: col, width: ink.u(3), passes: 1
      })
    }
    ink.ctx.restore()

    // A highlighter cone showing where it's pointed — without this the player
    // can't tell a near-miss from a wild miss on a small screen.
    if (sig > 0.05) {
      const r = 200 * s
      const spread = 0.24
      const pts: Pt[] = [{ x: hx, y: hy }]
      for (let i = 0; i <= 6; i++) {
        const a = this.angle - spread + (i / 6) * spread * 2
        pts.push({ x: hx + Math.cos(a) * r, y: hy + Math.sin(a) * r })
      }
      ink.fill(pts, sig > 0.99 ? HIGHLIGHT.green : HIGHLIGHT.yellow, sig * 0.3)
    }
  }

  // ── The static veil ──────────────────────────────────────────────────────

  /** Bake the cross-hatch once per resolution, then blit it. Regenerating a
   *  full-page hatch every frame costs ~40ms; a blit costs ~0.2ms. */
  private bakeVeil(ink: InkRenderer): HTMLCanvasElement {
    const wPx = Math.max(1, Math.round(ink.pw * ink.scale))
    const hPx = Math.max(1, Math.round(ink.ph * ink.scale))
    const key = `${wPx}x${hPx}`
    if (this.veil && this.veilKey === key) return this.veil

    const c = document.createElement('canvas')
    c.width = wPx
    c.height = hPx
    const g = c.getContext('2d')
    if (g) {
      g.scale(ink.scale, ink.scale)
      const bake = new InkRenderer(g)
      bake.ph = ink.ph
      bake.scale = ink.scale
      bake.boil = 0

      // Ruled hatch passes at fixed angles produce a tidy PLAID — unmistakably
      // a woven texture, and nothing like analog snow. Real charcoal shading
      // (and real TV static) is a mess of short scratches going every which
      // way with no shared axis. So the veil is thousands of individual random
      // strokes rather than ruled lines.
      //
      // This is expensive (~2500 strokes), which is exactly why it's baked once
      // per resolution and then blitted — and why it's baked during the boss's
      // 1.4s banner slam, where a one-off ~30ms hitch is invisible.
      const rng = mulberry32(0xbeef)
      const COUNT = 2500
      for (let i = 0; i < COUNT; i++) {
        const x = range(rng, -20, ink.pw + 20)
        const y = range(rng, -20, ink.ph + 20)
        const a = range(rng, 0, Math.PI * 2)
        const len = ink.u(range(rng, 8, 26))
        // A spread of greys so the mass reads as depth rather than one flat
        // wash of colour.
        const shade = Math.floor(range(rng, 170, 235))
        bake.stroke(`v${i}`, [
          { x, y },
          { x: x + Math.cos(a) * len, y: y + Math.sin(a) * len }
        ], {
          color: `rgb(${shade},${shade},${shade + 6})`,
          width: ink.u(range(rng, 1.4, 3.2)),
          alpha: range(rng, 0.25, 0.7),
          passes: 1,
          rough: 1.4
        })
      }
    }
    this.veil = c
    this.veilKey = key
    return c
  }

  private drawVeil(ctx: MicroGameCtx, amount: number): void {
    const { ink } = ctx
    if (amount <= 0.02) return
    const veil = this.bakeVeil(ink)
    ink.ctx.save()
    ink.ctx.setTransform(1, 0, 0, 1, 0, 0)
    ink.ctx.globalAlpha = Math.min(1, amount)
    // Jitter the veil's offset per boil frame so the snow crawls — a static
    // static would read as a texture, not interference.
    const rng = makeRng('veiljit', ink.boil)
    ink.ctx.drawImage(veil, range(rng, -6, 6), range(rng, -6, 6))
    ink.ctx.restore()
  }

  /** The ink-tube progress bar (GDD §4.4: "styled as a filling ink tube"). */
  private drawChargeTube(ctx: MicroGameCtx): void {
    const { ink, services } = ctx
    if (this.charge <= 0.02) return
    const p = Math.min(1, this.charge / CHARGE_S)
    const w = ink.u(300)
    const h = ink.u(34)
    const x = ink.cx - w / 2
    const y = Math.min(ink.ph - ink.u(70), ink.stage.y + ink.stage.h * 0.95)

    // Glass tube.
    ink.roundRect('tube', x, y, w, h, h / 2, { color: '#ffffff', width: ink.u(3), passes: 2 })
    // Ink filling it.
    ink.ctx.save()
    ink.ctx.beginPath()
    ink.ctx.rect(x, y, w * p, h)
    ink.ctx.clip()
    ink.roundRect('tubefill', x, y, w, h, h / 2, {
      color: HIGHLIGHT.cyan, width: ink.u(3), passes: 1
    })
    ink.fill([
      { x, y: y + h * 0.18 }, { x: x + w, y: y + h * 0.18 },
      { x: x + w, y: y + h * 0.82 }, { x, y: y + h * 0.82 }
    ], HIGHLIGHT.cyan, 0.85)
    ink.ctx.restore()

    inkText(ink, 'tubelabel', services.t(this.locked ? 'game.signal.hold' : 'game.signal.tune'), ink.cx, y - ink.u(18), ink.u(26), {
      align: 'center',
      color: '#ffffff',
      width: ink.u(3),
      tilt: 0.05
    })
  }

  private drawLightning(ctx: MicroGameCtx, p: number): void {
    const { ink } = ctx
    const rng = makeRng('bolt', 0)
    const pts: Pt[] = []
    const steps = 9
    for (let i = 0; i <= steps; i++) {
      const f = i / steps
      pts.push({
        x: f * ink.pw,
        y: ink.ph * 0.5 + range(rng, -ink.u(70), ink.u(70)) * (i === 0 || i === steps ? 0 : 1)
      })
    }
    const shown = Math.max(2, Math.round(pts.length * p))
    ink.stroke('bolt', pts.slice(0, shown), {
      color: HIGHLIGHT.yellow, width: ink.u(14), passes: 2, rough: 5, bleed: true
    })
    // The page tears along the bolt.
    if (p > 0.5) {
      ink.stroke('tear', pts.slice(0, shown), {
        color: NOTEBOOK.ink, width: ink.u(4), passes: 1, rough: 8
      })
    }
  }

  dispose(): void {
    this.staticLoop?.stop()
    this.melodyLoop?.stop()
    this.staticLoop = null
    this.melodyLoop = null
  }
}

export const findSignal = (): MicroGame => new FindSignal()
