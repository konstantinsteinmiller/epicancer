// ─── The micro-game contract ───────────────────────────────────────────────
//
// The anthology format is the GDD's scope insurance (§1.2): "If development
// runs behind, micro-games can be cleanly severed; if ahead, more can be
// hot-plugged without breaking the architecture." That promise is only real if
// the seam is narrow — so a micro-game knows NOTHING about the run around it.
// It cannot see the heart count, the score, or which game came before. It gets
// a page, a pointer, and a clock, and it reports won/lost. That's the whole
// interface.
//
// Adding a game = write one object and add it to the registry in
// `useMidnightGame.ts`. Removing one = delete the line.

import type { InkRenderer } from '@/use/ink/inkRenderer'
import type { ShakePreset, ShakeSpec } from '@/use/ink/useInkCanvas'

/** Pointer state in PAGE UNITS, shared by mouse and touch. Micro-games never
 *  touch DOM events — the scene normalises everything into this. */
export interface Pointer {
  x: number
  y: number
  /** True while the primary button / a finger is down. */
  down: boolean
  /** True only on the frame the press began. */
  pressed: boolean
  /** True only on the frame the press ended. */
  released: boolean
  /** Movement since the last frame, page units. Drives the wind gusts. */
  dx: number
  dy: number
  /** True once the pointer has ever been seen. Lets a game hold its "move the
   *  mouse!" hint until the player is actually present — and lets the touch
   *  path skip hover-only affordances. */
  seen: boolean
}

/** Everything a micro-game is allowed to do to the world outside itself. */
export interface GameServices {
  shake: (preset: ShakePreset | ShakeSpec, mul?: number) => void
  /** Invert the screen for N frames (GDD §5). Use on real impacts only —
   *  it's the loudest tool in the box and cheapens fast. */
  impactFrame: (frames?: number) => void
  /** 0..1 — how far into the night we are. Games may use it to add garnish,
   *  but MUST NOT use it to change their own difficulty: the core loop
   *  already escalates by shortening the clock and speeding transitions, and
   *  double-dipping makes late games unwinnable. */
  heat: number
  /** Translator. Even the onomatopoeia a game shouts ("SMACK!", "RUINED!") is
   *  player-facing copy and has to be localisable — so games get `t` rather
   *  than baking English into the draw calls. */
  t: (key: string) => string
}

export type MicroGameStatus = 'running' | 'won' | 'lost'

export interface MicroGameCtx {
  ink: InkRenderer
  pointer: Pointer
  services: GameServices
  /** Seconds since this micro-game started. */
  t: number
  /** Seconds remaining on the clock. */
  remaining: number
  /** Total seconds this micro-game was given. */
  duration: number
}

export interface MicroGame {
  /** Stable id — used for the save-blob stat bucket and the ink seeds, so
   *  changing it resets a player's per-game stats. */
  readonly id: string
  /** i18n key for the one-word verb flashed in the briefing (GDD §3.1). */
  readonly verbKey: string
  /** i18n key for the one-line hint under the verb on a player's first
   *  encounter with this game. */
  readonly hintKey: string
  /** Base seconds on the clock. The core loop scales this down as the night
   *  escalates; it never scales it up. */
  readonly baseDuration: number
  /** The boss runs long and replaces the whole page (GDD §4.4). */
  readonly isBoss?: boolean

  /** Fresh state for one play. `seed` varies per play so randomised layouts
   *  (the mosquito positions, the antenna hotspot) differ every time while
   *  staying reproducible for a given seed. */
  init(ctx: MicroGameCtx, seed: number): void
  /** Simulation tick at ~60Hz. Return a status to end the game early; return
   *  nothing to keep running. The core loop calls a timeout a loss on its own,
   *  so a game only needs to report a WIN — unless it has its own fail state
   *  (the ice cream tipping past 45°). */
  update(ctx: MicroGameCtx, dt: number): MicroGameStatus | void
  /** Draw at 12fps. Must be pure w.r.t. game state — it can be skipped or
   *  called twice for the same sim state (e.g. after a resize). */
  draw(ctx: MicroGameCtx): void
  /** Draw the post-resolution beat (the LED going green, the ink splatter).
   *  `outcome` is settled; `since` is seconds since it settled. Optional —
   *  games without a distinct outro just keep rendering `draw`. */
  drawOutcome?(ctx: MicroGameCtx, outcome: 'won' | 'lost', since: number): void
  /** Release loops/handles. Always called, even if the game never started. */
  dispose?(): void
}
