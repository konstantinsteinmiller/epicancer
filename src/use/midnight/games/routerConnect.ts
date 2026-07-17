// ─── Micro-game 1: Router — "CONNECT!" ─────────────────────────────────────
//
// GDD §4.1 / vision-board panel 3: a shaky hand-drawn router with a blinking
// red LED. A thick power cord is unplugged and "violently snapping back and
// forth like a severed live wire". Grab the plug, drag it into the port before
// the clock runs out.
//
// ── On the verb ──
// GDD §4.1 titles this one "SMASH!", but §3.1 lists that as a generic example
// and vision-board panel 3 calls it "CONNECT!". In a WarioWare-style game the
// verb IS the instruction — the player has ~1.5s to read one word and know
// what to do. "SMASH!" would send them hammering the router instead of
// dragging the plug, so the vision board's verb wins.
//
// ── On the physics ──
// The cord is a Verlet rope (GDD asks for exactly this). Verlet is the right
// tool: it's stable under the violent impulses the thrashing needs, it gives
// the elastic drag the GDD wants for free, and — unlike a spring solver — it
// cannot explode when the player yanks the plug across the page in one frame.

import type { MicroGame, MicroGameCtx } from '../types'
import { NOTEBOOK } from '@/use/ink/palette'
import { mulberry32, range } from '@/use/ink/rng'
import { clack, sourBuzz, penClick } from '@/use/ink/useInkAudio'
import type { Pt } from '@/use/ink/inkRenderer'

interface Node {
  x: number
  y: number
  px: number
  py: number
  pinned: boolean
}

const SEGMENTS = 14
/** Constraint solver iterations. 8 is the knee of the curve: below ~5 the
 *  rope visibly stretches when yanked, above ~10 costs frame time for no
 *  visible gain. */
const ITER = 8
const GRAVITY = 1400
/** Velocity retained per frame while the cord is loose. High = it keeps
 *  whipping; this is the "severed live wire" liveliness dial. */
const DAMP = 0.985
/** Velocity retained per frame ONCE THE PLAYER HAS THE PLUG.
 *
 *  This is the difference between a game and a fight. The loose cord carries a
 *  lot of momentum, and at the loose damping it keeps flailing for seconds
 *  after you grab it — so the thing you're trying to aim is still bucking in
 *  your hand. Grabbing the plug is the player winning the first half of the
 *  puzzle; the cord goes quiet and aiming becomes the second half. */
const DAMP_HELD = 0.72

class RouterConnect implements MicroGame {
  readonly id = 'router'
  readonly verbKey = 'game.router.verb'
  readonly hintKey = 'game.router.hint'
  // Deliberately 2× the GDD's 5s. Catching a thrashing plug AND steering it
  // into a socket is two tasks, and at 5s the round was over before the second
  // one started — it read as unfair rather than frantic. The escalation curve
  // still squeezes this down as the night heats up (`durationFor`).
  readonly baseDuration = 10

  private nodes: Node[] = []
  private segLen = 0
  private grabbed = false
  private connected = false
  private rng: () => number = Math.random

  // Layout, in page units — recomputed on init so a resize between plays
  // lays out correctly for the new aspect.
  private rx = 0
  private ry = 0
  private rw = 0
  private rh = 0
  private portX = 0
  private portY = 0
  private portR = 0
  private anchorX = 0
  private anchorY = 0

  init(ctx: MicroGameCtx, seed: number): void {
    const { ink } = ctx
    this.rng = mulberry32(seed)
    this.grabbed = false
    this.connected = false

    // The router sits high in the STAGE box; the cord dangles into the open
    // space below it, so the drag is a big upward sweep. Anchoring to the
    // stage (not the raw page) keeps the whole assembly composed on a tall
    // phone instead of stranding it at the top — see `InkRenderer.stage`.
    // Sizes are fractions of the STAGE, not absolute page units. A router
    // authored at "340 units" is a comfortable 34% of a desktop's width and a
    // 110px toy on a 320px phone — too small to grab with a thumb. Expressing
    // it as 62% of the stage width makes it the same READABLE size everywhere,
    // which is what actually matters on a 5-second clock.
    const st = ink.stage
    this.rw = st.w * 0.62
    this.rh = this.rw * 0.42
    this.rx = st.cx - this.rw / 2
    this.ry = st.y + st.h * 0.14

    // The port is on the router's lower-left face — offset from the cord's
    // anchor so the player must actually steer, not just drag straight up.
    this.portX = this.rx + this.rw * 0.24
    this.portY = this.ry + this.rh + this.rw * 0.012
    this.portR = this.rw * 0.095

    this.anchorX = this.rx + this.rw * 0.92
    this.anchorY = this.ry + this.rh * 0.72

    // Rope hangs from the anchor down toward the foot of the stage — a fixed
    // fraction, so the cord is a full sweep of the play area on every screen.
    const endY = st.y + st.h * 0.76
    this.segLen = (endY - this.anchorY) / SEGMENTS
    this.nodes = []
    for (let i = 0; i <= SEGMENTS; i++) {
      const x = this.anchorX + range(this.rng, -ink.u(8), ink.u(8))
      const y = this.anchorY + this.segLen * i
      this.nodes.push({ x, y, px: x, py: y, pinned: i === 0 })
    }
    // Kick it sideways so it's already thrashing on frame one — a cord that
    // starts limp and works up to violent wastes the player's short clock.
    const tip = this.nodes[SEGMENTS]!
    tip.px = tip.x - range(this.rng, this.rw * 0.12, this.rw * 0.22)
  }

  private get tip(): Node { return this.nodes[SEGMENTS]! }

  update(ctx: MicroGameCtx, dt: number) {
    const { pointer, ink, services } = ctx
    if (this.connected) return

    // Generous, and proportional to the art — this must be forgiving for a
    // thumb on a 320px screen chasing a moving target.
    const grabR = this.rw * 0.3

    // Grab on PROXIMITY-WHILE-DOWN, not on the press edge alone. Requiring the
    // press to land on a fast-moving plug is a reaction test the game never
    // meant to be about: you'd stab at it and miss, over and over. Holding the
    // button and sweeping across the cord now catches it, which is what players
    // instinctively try.
    if (pointer.down && !this.grabbed) {
      const d = Math.hypot(pointer.x - this.tip.x, pointer.y - this.tip.y)
      if (d <= grabR) {
        this.grabbed = true
        penClick()
        // Kill the cord's momentum the instant it's caught. Without this the
        // rope keeps whipping from everything it built up while loose, and the
        // player is trying to aim a thing that's still fighting them.
        for (const n of this.nodes) {
          n.px = n.x
          n.py = n.y
        }
      }
    }
    if (pointer.released) this.grabbed = false

    this.step(ctx, dt)

    if (this.grabbed) {
      // The plug follows the pointer directly rather than being spring-pulled
      // toward it. Direct control is what makes the drag feel like YOUR hand;
      // the rope's weight still fights back through the constraint pass.
      const tip = this.tip
      tip.px = tip.x
      tip.py = tip.y
      tip.x = pointer.x
      tip.y = pointer.y

      // A forgiving catch: the player has already done the hard part by
      // grabbing the plug and steering it across the page. Demanding pixel
      // accuracy at the socket adds frustration, not challenge.
      const d = Math.hypot(pointer.x - this.portX, pointer.y - this.portY)
      if (d <= this.portR * 2.2) {
        this.connected = true
        clack()
        services.shake('thud')
        services.impactFrame(2)
        return 'won'
      }
    }
    return undefined
  }

  /** Dev-only view of the cord (see GameScene's `__midnight.state().detail`).
   *  `tipSpeed` is what "still wobbling" actually means numerically — it must
   *  collapse to ~0 once the plug is grabbed. */
  debug() {
    const tip = this.tip
    return {
      grabbed: this.grabbed,
      connected: this.connected,
      tip: { x: Math.round(tip.x), y: Math.round(tip.y) },
      port: { x: Math.round(this.portX), y: Math.round(this.portY) },
      grabR: Math.round(this.rw * 0.3),
      tipSpeed: +Math.hypot(tip.x - tip.px, tip.y - tip.py).toFixed(2)
    }
  }

  /** One Verlet integration + constraint relaxation pass. */
  private step(ctx: MicroGameCtx, dt: number): void {
    const { ink } = ctx
    // Verlet is not dt-invariant, so a variable frame time changes the
    // effective stiffness. Clamping to a sane band keeps the cord behaving
    // identically at 60Hz and 144Hz instead of going noodly on fast displays.
    const h = Math.min(0.022, Math.max(0.008, dt))

    const damp = this.grabbed ? DAMP_HELD : DAMP
    for (let i = 1; i < this.nodes.length; i++) {
      const n = this.nodes[i]!
      if (n.pinned) continue
      const vx = (n.x - n.px) * damp
      const vy = (n.y - n.py) * damp
      n.px = n.x
      n.py = n.y
      n.x += vx
      n.y += vy + GRAVITY * h * h
    }

    // The "severed live wire" thrash: random impulses along the free half of
    // the cord while nobody is holding it. Applied to the tip hardest.
    //
    // Tuned DOWN from its original amplitude: the cord has to look alive, but
    // the plug also has to be catchable. Past a certain speed the player stops
    // reading it as "an angry cable" and starts reading it as "the game won't
    // let me click the thing".
    if (!this.grabbed) {
      const t = ctx.t
      for (let i = Math.floor(SEGMENTS * 0.5); i < this.nodes.length; i++) {
        const n = this.nodes[i]!
        const w = i / SEGMENTS
        // A sine chorus rather than white noise: noise reads as jitter, a
        // beating of incommensurate sines reads as a whipping cable.
        const f =
          Math.sin(t * 7 + i * 0.7) * 0.6 +
          Math.sin(t * 11.3 + i * 1.9) * 0.3 +
          Math.sin(t * 3.7 + i * 0.3) * 0.5
        n.x += f * this.rw * 0.0045 * w
        n.y += Math.cos(t * 9.1 + i) * this.rw * 0.0018 * w
      }
    }

    const tip = this.tip
    if (this.grabbed) {
      tip.x = ctx.pointer.x
      tip.y = ctx.pointer.y
    }

    for (let k = 0; k < ITER; k++) {
      for (let i = 0; i < this.nodes.length - 1; i++) {
        const a = this.nodes[i]!
        const b = this.nodes[i + 1]!
        const dx = b.x - a.x
        const dy = b.y - a.y
        const d = Math.hypot(dx, dy) || 0.0001
        const diff = (d - this.segLen) / d
        // A pinned/held node contributes no correction, so its partner takes
        // the whole displacement — that's what makes the anchor and the
        // player's hand feel immovable.
        const aFixed = a.pinned
        const bFixed = b === tip && this.grabbed
        if (aFixed && bFixed) continue
        const share = aFixed || bFixed ? 1 : 0.5
        if (!aFixed) {
          a.x += dx * diff * share
          a.y += dy * diff * share
        }
        if (!bFixed) {
          b.x -= dx * diff * share
          b.y -= dy * diff * share
        }
      }
      // Keep the cord on the page.
      for (const n of this.nodes) {
        if (n.pinned) continue
        n.x = Math.max(ink.u(14), Math.min(ink.pw - ink.u(14), n.x))
        n.y = Math.min(ink.ph - ink.u(14), n.y)
      }
    }
  }

  draw(ctx: MicroGameCtx): void {
    const { ink } = ctx
    this.drawRouter(ctx)
    this.drawCord(ctx)
  }

  drawOutcome(ctx: MicroGameCtx, outcome: 'won' | 'lost', since: number): void {
    const { ink } = ctx
    if (outcome === 'won') {
      this.drawRouter(ctx, true)
      this.drawCord(ctx)
      // "A large marker wave of Wi-Fi signals arcs outward" (GDD §4.1).
      const waves = 3
      for (let i = 0; i < waves; i++) {
        const age = since - i * 0.12
        if (age < 0) continue
        const r = ink.u(60) + age * ink.u(420)
        const alpha = Math.max(0, 1 - age * 1.3)
        if (alpha <= 0) continue
        const pts: Pt[] = []
        // An arc, not a ring — signal radiating up and out of the router.
        for (let s = 0; s <= 14; s++) {
          const a = Math.PI * 1.15 + (s / 14) * Math.PI * 0.7
          pts.push({
            x: this.rx + this.rw / 2 + Math.cos(a) * r,
            y: this.ry + this.rh * 0.3 + Math.sin(a) * r * 0.8
          })
        }
        ink.stroke(`wifi${i}`, pts, {
          color: NOTEBOOK.markerGreen, width: ink.u(7), alpha, passes: 1, rough: 3
        })
      }
    } else {
      // "The router explodes into an ink splatter, leaving a dark smudge"
      // (GDD §4.1).
      const g = Math.min(1, since * 3)
      this.drawCord(ctx)
      ink.splatter(
        'boom', this.rx + this.rw / 2, this.ry + this.rh / 2,
        ink.u(50) + g * ink.u(60), NOTEBOOK.ink, 18, 3.4
      )
      ink.actionLines(
        'boomlines', this.rx + this.rw / 2, this.ry + this.rh / 2,
        ink.u(70), ink.u(70) + g * ink.u(120), 11
      )
    }
  }

  private drawRouter(ctx: MicroGameCtx, won = false): void {
    const { ink, t } = ctx
    const { rx, ry, rw, rh } = this

    // Two antennae.
    for (let i = 0; i < 2; i++) {
      const ax = rx + rw * (i === 0 ? 0.22 : 0.78)
      const lean = (i === 0 ? -1 : 1) * rw * 0.05
      ink.stroke(`ant${i}`, [
        { x: ax, y: ry },
        { x: ax + lean * 0.4, y: ry - rh * 0.4 },
        { x: ax + lean, y: ry - rh * 0.74 }
      ], { width: rw * 0.011, rough: 1.6 })
      ink.fillCircle(ax + lean, ry - rh * 0.74, rw * 0.011, NOTEBOOK.ink)
    }

    // Body.
    ink.roundRect('body', rx, ry, rw, rh, rw * 0.03, { width: rw * 0.008, bleed: true })
    // Vents.
    for (let i = 0; i < 4; i++) {
      const vy = ry + rh * (0.3 + i * 0.16)
      ink.line(`vent${i}`, rx + rw * 0.55, vy, rx + rw * 0.86, vy, {
        color: NOTEBOOK.inkSoft, width: rw * 0.004, passes: 1, alpha: 0.7
      })
    }

    // The LED: "a bright red, pixelated LED blinks angrily" — and flashes
    // neon-green on connect (GDD §4.1).
    const blink = won ? 1 : (Math.sin(t * 14) > -0.2 ? 1 : 0.15)
    const ledColor = won ? NOTEBOOK.markerGreen : NOTEBOOK.markerRed
    const lx = rx + rw * 0.18
    const ly = ry + rh * 0.42
    const ledR = rw * 0.026
    ink.fillCircle(lx, ly, ledR, ledColor, blink)
    ink.circle('led', lx, ly, ledR, { width: rw * 0.005, passes: 1 })
    if (blink > 0.5) {
      ink.actionLines('ledglow', lx, ly, ledR * 1.5, ledR * 2.4, 6, ledColor)
    }

    // The port — highlighted because it's the target. Highlighter is the
    // game's "you can interact with this" language (GDD §2.2), and it pulses
    // so the eye finds it inside the 5-second clock.
    const pulse = 0.4 + Math.sin(t * 9) * 0.18
    ink.highlightBlob('porthl', this.portX, this.portY, this.portR * 1.25, 'yellow', pulse)
    ink.rect('port', this.portX - this.portR * 0.55, this.portY - this.portR * 0.42,
      this.portR * 1.1, this.portR * 0.84, { width: this.portR * 0.12, color: NOTEBOOK.markerRed })
    // Two prong slots.
    for (let i = 0; i < 2; i++) {
      const sx = this.portX + (i === 0 ? -1 : 1) * this.portR * 0.24
      ink.line(`slot${i}`, sx, this.portY - this.portR * 0.2, sx, this.portY + this.portR * 0.2, {
        width: this.portR * 0.1, color: NOTEBOOK.ink, passes: 1
      })
    }
  }

  private drawCord(ctx: MicroGameCtx): void {
    const { ink } = ctx
    const pts: Pt[] = this.nodes.map((n) => ({ x: n.x, y: n.y }))

    // The cord: thick and dark. Low `rough` because the rope's own simulated
    // shape already carries all the motion — piling pen-wobble on top of it
    // reads as noise rather than energy.
    ink.stroke('cord', pts, { width: this.rw * 0.018, rough: 1.2, passes: 2, bleed: true })

    // The plug at the tip.
    const tip = this.tip
    const prev = this.nodes[SEGMENTS - 1]!
    const a = Math.atan2(tip.y - prev.y, tip.x - prev.x)
    ink.transformed(tip.x, tip.y, a, 1, () => {
      const w = this.rw * 0.14
      const h = w * 0.65
      ink.rect('plug', -w * 0.35, -h / 2, w, h, { width: w * 0.09, bleed: true })
      // Prongs.
      for (let i = 0; i < 2; i++) {
        const py = (i === 0 ? -1 : 1) * h * 0.22
        ink.line(`prong${i}`, w * 0.65, py, w * 0.95, py, { width: w * 0.08 })
      }
    })

    // Grab affordance: highlight the plug while it's loose so the player's eye
    // goes to the thing they're meant to catch.
    if (!this.grabbed && !this.connected) {
      ink.highlightBlob('plughl', tip.x, tip.y, this.rw * 0.11, 'cyan', 0.34)
    }
  }
}

export const routerConnect = (): MicroGame => new RouterConnect()
