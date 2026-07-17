import { ref, computed, type Ref } from 'vue'
import useSounds, { setMusicRate } from '@/use/useSound'
import { useScreenshake } from '@/use/useScreenshake'
import useEpicProgress, { tilesToClear, upgradedValue } from '@/use/useEpicProgress'
import useBattlePass from '@/use/useBattlePass'
import usePowerups, { type PowerupType } from '@/use/usePowerups'
import { difficultySpeedFactor } from '@/use/useUser'
import { getState, setState } from '@/use/useEpicState'
import { ONBOARDED_KEY, BEST_ENDLESS_KEY } from '@/keys'
import { flushSaveNow } from '@/use/useSaveStatus'
import { triggerBallDropIn, getRowsBelowBall, getRowsAboveBall } from '@/use/useEpicArt'

/**
 * Core game loop for Epicrolla.
 *
 * A ball rolls UP an isometric diamond grid, hopping diamond-to-diamond along
 * the diamond edges. Each hop goes one row up and one column left or right; a
 * tap flips the horizontal heading (NE ⇄ NW). The ball bounces off the field's
 * side edges. Score = diamonds entered. Speed ramps over time.
 *
 * The simulation is pure-lattice (integer cell `{c, r}` + a 0..1 `progress`
 * toward the next diamond). All pixel geometry / iso projection lives in the
 * renderer (`useEpicArt`), which reads the exported `game` snapshot. Valid
 * diamonds satisfy `(c + r) even`; the two up-neighbours of `(c, r)` are
 * `(c-1, r-1)` and `(c+1, r-1)`.
 */

export type Phase = 'idle' | 'playing' | 'dead' | 'won'
export type GameResult = '' | 'win' | 'lose'
export type LossCause = '' | 'hole' | 'crash'

export type ObstacleKind = 'box' | 'pyramid' | 'stone' | 'wall' | 'libertyCat' | 'crate'
export type CellKind = 'floor' | 'hole' | 'obstacle' | 'coin' | 'item' | 'portal' | 'lava'

export interface Cell {
  c: number
  r: number
  kind: CellKind
  obstacle?: ObstacleKind
  /** Coin already swallowed (kept for a frame so the renderer can fade it). */
  collected?: boolean
  /** Item box only: a rare "lucky" box that grants a double-duration power-up.
   *  The renderer draws it with a distinct golden glow to telegraph the drop. */
  lucky?: boolean
  /** Crate-pile member: a 2×2 destructible pile spanning four diamonds. Every one
   *  of the four cells carries the SAME bottom-front anchor coords (crateBC,
   *  crateBR). The renderer draws ONE pile sprite from the anchor cell and skips
   *  the rest; destroying any member clears all four together (acts like a box). */
  crateBC?: number
  crateBR?: number
}

export interface FxEvent {
  kind: 'coin' | 'pop' | 'push' | 'item' | 'sparkle' | 'explode' | 'portal' | 'shatter'
  c: number
  r: number
  bornAt: number
  color?: string
  /** For the 'shatter' kind: which obstacle sprite to tear into shards. */
  obstacle?: ObstacleKind
}

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Diamond column span [0, C_MAX]. ~6 diamonds across a row. */
export const C_MAX = 10
const GEN_AHEAD = 29
const CULL_BEHIND = 9

const BASE_SPEED = 2.5          // diamonds / second at the START of stage 1
const MAX_SPEED = 8

// Per-stage STARTING speed (diamonds/sec). A slower, stretched ramp (rebalance):
//   • stages 1 → 20 : 2.50 → 4.12  (the old stage-10 start speed now lands at 20)
//   • stages 20 → 50: 4.12 → 7.72  (the old stages 11-30 stretched over 20-50)
//   • stages 50+     : +0.18/stage, clamped to the MAX_SPEED cap (~stage 52)
// Each segment is linear; the result is clamped to MAX_SPEED. Replaces the old
// single `BASE_SPEED + (s-1) * 0.18` line.
//
// Stages 1-2 are OVERRIDDEN above the ramp: the ramp made the opener roll so
// slowly it bored players into early drop-outs (especially on mobile, where the
// shorter viewport makes the crawl even more obvious). Stage 2 = its old ramp
// value (~2.59) +10%; stage 1 = that stage-2 speed +10% again, so the very
// first run actually has pace. Stage 3+ keeps the original stretched ramp.
const STAGE2_START_SPEED = (BASE_SPEED + (4.12 - BASE_SPEED) / 19) * 1.1 // ~2.84
const STAGE1_START_SPEED = STAGE2_START_SPEED * 1.1                      // ~3.13
const startSpeedForStage = (stage: number): number => {
  const s = Math.max(1, stage)
  if (s === 1) return STAGE1_START_SPEED
  if (s === 2) return STAGE2_START_SPEED
  let v: number
  if (s <= 20) v = BASE_SPEED + (s - 1) * ((4.12 - BASE_SPEED) / 19)
  else if (s <= 50) v = 4.12 + (s - 20) * ((7.72 - 4.12) / 30)
  else v = 7.72 + (s - 50) * 0.18
  return Math.min(MAX_SPEED, v)
}

// Within-stage acceleration: the ball speeds up as the player nears the goal.
// Stages 1-10 ramp a gentle +30% over the whole stage (beginner-friendly);
// stage 11+ ramp a steeper +66%. (Knee stretched from the old stage 6 so the
// end-of-stage speed reaches the old stage-10 value of ~6.84 at the new stage 20.)
const EARLY_STAGE_RAMP = 0.30
const LATE_STAGE_RAMP = 0.66
const RAMP_KNEE_STAGE = 10

const START_RUNWAY = 7          // rows of guaranteed-safe floor at the start
// Push Force / shatter-able obstacles. `wall` is included because it renders
// with the SAME box sprite as `box` (see useEpicArt `obstacleSrc`) — to the
// player it IS a wooden box, so Push Force must clear it too, otherwise the
// power-up "fails" on a hazard that looks identical to a pushable one.
const SMALL_OBSTACLES: ObstacleKind[] = ['box', 'stone', 'wall', 'crate']

/** How long (ms) the ball spends sinking into a hole before death registers.
 *  Read by the renderer to drive the drop visual. */
export const DROP_MS = 420

// ─── Rubber-band difficulty (session-only) ──────────────────────────────────
//
// Strugglers on the first three stages get a gentler goal: each FAILED attempt
// on a stage shaves 10% off that stage's tile target, down to a 50% floor. So a
// player who has lost 4 times on stage 1 only needs 18 tiles (30 × 0.6) to clear
// it. Kept in a module-level Map that is intentionally NOT persisted to
// localStorage/SDK — it resets on reload, which is acceptable.
const RUBBER_BAND_STAGES = 3
const stageFailCounts = new Map<number, number>()

/** Effective tile goal for a stage, applying the first-3-stages rubber band. */
const rubberBandedTarget = (stage: number): number => {
  const base = tilesToClear(stage)
  if (stage > RUBBER_BAND_STAGES) return base
  const fails = stageFailCounts.get(stage) ?? 0
  const factor = Math.max(0.5, 1 - 0.1 * fails) // −10%/fail, floor 50%
  return Math.max(1, Math.round(base * factor))
}

// ─── Game mode: campaign vs endless (roadmap #9) ────────────────────────────
//
// Campaign = the staged progression (clear a tile goal → next stage). Endless
// "Zen / Marathon" = no tile goal, a gentler time-based ramp, scored on tiles
// travelled with its own persisted best. Toggled from the idle screen.
export type GameMode = 'campaign' | 'endless'
export const gameMode: Ref<GameMode> = ref('campaign')
export const setGameMode = (m: GameMode): void => { gameMode.value = m }
/** Endless personal best (tiles), persisted separately from the campaign best. */
export const bestEndless: Ref<number> = ref(Math.max(0, Number(getState<number>(BEST_ENDLESS_KEY, 0)) || 0))

// ─── Late-stage death rubber band (campaign, stage 10+, session-only) ────────
//
// Late stages can't lower the tile goal (that band is stages 1-3 only), so a
// player stuck on stage 10+ instead gets the FIELD eased each failed attempt:
//   • obstacle density −5% per death, down to −35% (more room to breathe), and
//   • travel speed −2% per death, down to −20% (more reaction time).
// Both read the same per-stage `stageFailCounts` (incremented in `die`), so they
// melt away the moment the player clears the stage and moves on. Campaign-only;
// not persisted (resets on reload), like the rest of the rubber band.
const LATE_RUBBER_BAND_FROM = 10
/** Obstacle-density relief fraction (0..0.35) for a stuck player at stage 10+. */
const lateStageObstacleRelief = (stage: number): number => {
  if (gameMode.value !== 'campaign' || stage < LATE_RUBBER_BAND_FROM) return 0
  return Math.min(0.35, 0.05 * (stageFailCounts.get(stage) ?? 0))
}
/** Travel-speed relief fraction (0..0.20) for a stuck player at stage 10+. */
const lateStageSpeedRelief = (stage: number): number => {
  if (gameMode.value !== 'campaign' || stage < LATE_RUBBER_BAND_FROM) return 0
  return Math.min(0.20, 0.02 * (stageFailCounts.get(stage) ?? 0))
}

// ─── Adaptive spawn director (roadmap #8, session-only) ─────────────────────
//
// Counts deaths per hazard kind this session; the hazard that has been killing
// the player most has its spawn weight reduced for upcoming runs (decays as
// they survive), keeping strugglers in flow without dumbing the game down for
// everyone. Not persisted — resets on reload.
type HazardKey = 'hole' | 'lava' | 'box' | 'stone' | 'pyramid' | 'wall' | 'libertyCat' | 'crate'
const hazardDeaths = new Map<HazardKey, number>()
/** What killed the player on the current run (for the director + adaptive UI). */
let lastKillerKind: HazardKey | null = null

const hazardKeyOf = (kind: CellKind, obstacle?: ObstacleKind): HazardKey | null => {
  if (kind === 'hole') return 'hole'
  if (kind === 'lava') return 'lava'
  if (kind === 'obstacle' && obstacle) return obstacle
  return null
}

// ─── Onboarding (roadmap #7) ────────────────────────────────────────────────
//
// The player's first-ever run gets a longer safe runway, a gentler speed ramp,
// and a guided "tap to turn" callout. `epic_onboarded` flips true once that run
// finishes, so the assist shows exactly once.
export const isOnboardingRun: Ref<boolean> = ref(getState<boolean>(ONBOARDED_KEY, false) !== true)
const ONBOARD_RUNWAY_BONUS = 10 // extra guaranteed-safe rows on the first run

// ─── Stage-clear boons (roadmap #13, session/transient) ─────────────────────
//
// On each stage clear the player picks one of three boons for the NEXT stage.
// The choice is stored here and consumed by `resetForStage` / `begin`.
export type BoonId = 'secondChance' | 'startPowerup' | 'coinBoost'
const pendingBoon: Ref<BoonId | null> = ref(null)
export const setPendingBoon = (b: BoonId): void => { pendingBoon.value = b }
/** True while a 1.2× coin boon is active for the current stage. */
let coinBoostActive = false
/** Power-up to grant at the start of the run (from the 'startPowerup' boon). */
let pendingStartPowerup: PowerupType | null = null

// ─── Per-run metrics surface (roadmap #2 daily missions) ────────────────────
const itemsThisRun: Ref<number> = ref(0)

const cellKey = (c: number, r: number): string => `${c},${r}`
const isSmall = (o: ObstacleKind | undefined): boolean => !!o && SMALL_OBSTACLES.includes(o)

// ─── Module-singleton simulation state (read by the renderer) ────────────────

export const game = {
  phase: 'idle' as Phase,
  cells: new Map<string, Cell>(),
  fx: [] as FxEvent[],
  // Ball lattice position
  cell: { c: 4, r: 0 },
  target: { c: 5, r: -1 },
  progress: 0,
  dir: 1 as 1 | -1,
  nextDir: 1 as 1 | -1,
  // Float render position (lerp of cell→target)
  ballC: 4,
  ballR: 0,
  speed: BASE_SPEED,
  clock: 0,            // monotonic game ms (excludes pauses)
  runStartClock: 0,
  // generation frontier (most-negative r generated)
  genR: 0,
  itemSpawned: 0,
  pendingItem: false,
  // Ball is sinking into a hole: freezes movement and drives the drop visual
  // until `dropClock` reaches DROP_MS, at which point death registers.
  dropping: false,
  dropClock: 0,
  // Ball has blown up (obstacle / lava) — the renderer stops drawing it so the
  // explosion FX reads as the ball being destroyed rather than parked.
  exploded: false,
  // Game-clock ms until which post-teleport slow-motion is active. While
  // `clock < teleportSlowUntil` movement is 80% slower and the renderer dims
  // the grid + spotlights the ball so the player can re-orient.
  teleportSlowUntil: 0,
  // Persistent Second Chance pickup: lasts until the stage ends and turns the
  // next obstacle/lava hit into a survivable save instead of death. Gaps (holes)
  // still kill the player.
  secondChance: false,
  // game-clock ms until which the ball blinks (opacity) after spending a chance.
  secondChanceBlinkUntil: 0,
  // Dodge Apprentice cooldown gate: game-clock ms at/after which a dodge is
  // available again. 0 = ready (each run starts with one charge).
  dodgeReadyAt: 0,
  // Game-clock ms at which a Second Chance was just spent — the renderer reads
  // a fresh (changed) value to spawn the angel-wings tear-apart shatter. 0 = none.
  wingsBreakAt: 0,
  // Racer auto-pilot dash: tiles left in the hands-off 5× sprint, then a short
  // exit-runway guard that keeps clearing safe ground as control hands back.
  racerTilesLeft: 0,
  racerExitGuard: 0,
  // Game-clock ms at which a power-up / Racer was just picked up — the renderer
  // reads a fresh (changed) non-zero value to fire the chromatic pickup pulse.
  powerupFlashAt: 0,
  // ─── Stage-clear EXIT sequence (campaign) ─────────────────────────────────
  // On reaching the tile goal the run doesn't end immediately: control is taken
  // away, an exit-gate wall spawns a few rows ahead, and the ball auto-rolls
  // through the archway and vanishes behind it before `win()` fires. The renderer
  // reads these to freeze the camera, place the gate and animate the roll.
  exiting: false,
  exitStartClock: 0,   // game.clock when the sequence began
  exitFromC: 0,        // ball float position at the start (camera locks here)
  exitFromR: 0,
  exitGateC: 0,        // gate (archway) lattice position the ball rolls into
  exitGateR: 0
}

/** Duration (ms) of the post-teleport orientation slow-motion. */
export const TELEPORT_SLOW_MS = 2000
/** Movement speed multiplier while post-teleport slow-mo is active (−80%). */
const TELEPORT_SLOW_FACTOR = 0.2
/** How long (ms) the ball blinks after spending a Second Chance. */
export const SECOND_CHANCE_BLINK_MS = 1600

/** Stage-clear exit-gate sequence (campaign): total duration of the auto-roll
 *  through the archway, and how many rows ahead of the ball the gate spawns.
 *  Exported so the renderer can drive the gate rise + ball-fade animation. */
export const EXIT_SEQUENCE_MS = 2300
// Minimum rows ahead the gate spawns. The ACTUAL distance is the larger of this
// and the live ball→top-edge row count (`getRowsAboveBall`) so the gate always
// starts off-screen above the viewport and scrolls in — this constant only
// governs short/landscape viewports where few rows fit above the ball.
export const EXIT_GATE_ROWS_AHEAD = 11
/** Extra rows beyond the top edge so the gate is fully hidden at spawn (rather
 *  than peeking a sliver) and reads as scrolling cleanly in from above. */
const EXIT_GATE_MARGIN_ROWS = 2
/** Final approach: this many tiles before the goal, stop spawning obstacles in the
 *  central lane (and everything beyond the goal) so the ball can roll cleanly to
 *  the exit gate without obstacles having to be deleted at the last second. */
const EXIT_APPROACH_TILES = 7

// ─── Reactive HUD surface ─────────────────────────────────────────────────

const phase: Ref<Phase> = ref('idle')
const score: Ref<number> = ref(0)
const gameResult: Ref<GameResult> = ref('')
const lossCause: Ref<LossCause> = ref('')
const coinsThisRun: Ref<number> = ref(0)
const lastWinReward: Ref<number> = ref(0)
const stageTarget: Ref<number> = ref(tilesToClear(1))
const survivalMs: Ref<number> = ref(0)

// ─── Risk-combo multiplier (roadmap #6) ─────────────────────────────────────
//
// The coin multiplier rewards RISK, not coin-vacuuming. It only climbs on close
// calls — when the player earns their keep:
//   • a last-tile turn-AWAY from an obstacle (flipped just before a fatal cell),
//   • an auto-dodge swinging the ball off a lethal cell, or
//   • surviving a fatal hit on the angel-wings Second Chance.
// Each close call bumps it +COMBO_STEP up to COMBO_MAX. It resets to 1× on death
// or after COMBO_WINDOW_MS with no close call (a hot streak you must keep feeding
// with daring play). Coins are MULTIPLIED by it but no longer feed it.
export const combo: Ref<number> = ref(1)
const COMBO_WINDOW_MS = 5000
const COMBO_STEP = 0.1
const COMBO_MAX = 3
let lastComboAt = -Infinity

// ─── Racer pickup (auto-pilot dash) ─────────────────────────────────────────
//
// A rare item-box drop that takes the wheel: the ball rockets forward at 5×
// speed along a safe path for RACER_TILES tiles (no player control, item boxes
// skipped, hazards cleared), then hands back a clean runway. `racerActive` is a
// reactive mirror of the game-state counters for the HUD badge.
const RACER_TILES = 25       // standard Racer drop (rare non-lucky box)
const RACER_TILES_GOLDEN = 40 // golden (lucky) box → a longer dash
const RACER_SPEED_MULT = 5
const RACER_EXIT_RUNWAY = 2
export const racerActive: Ref<boolean> = ref(false)

/** Reactive mirror of `game.exiting` — true during the stage-clear exit-gate
 *  cinematic, so the scene can hide the in-run HUD while it plays. */
export const exitingActive: Ref<boolean> = ref(false)

const useEpicGame = () => {
  const { playSound, playRandomVariant } = useSounds()
  const { triggerShake } = useScreenshake()
  const progress = useEpicProgress()
  const { awardAttempt } = useBattlePass()
  const powerups = usePowerups()

  const emitFx = (kind: FxEvent['kind'], c: number, r: number, color?: string, obstacle?: ObstacleKind): void => {
    game.fx.push({ kind, c, r, bornAt: game.clock, color, obstacle })
    // Keep the fx list bounded.
    if (game.fx.length > 80) game.fx.splice(0, game.fx.length - 80)
  }

  // Throttle the coin-pickup SFX so a magnet sweep / dense coin run doesn't
  // machine-gun overlapping clips. 150ms min spacing between plays.
  let lastCoinSoundAt = -Infinity
  const playCoinSound = (): void => {
    if (game.clock - lastCoinSoundAt < 150) return
    lastCoinSoundAt = game.clock
    playSound('coin-pickup', 0.05, 1 + (Math.random() - 0.5) * 0.1)
  }

  /** Fire a short device-vibration if supported (roadmap #14 haptics). Silently
   *  ignored on desktop / unsupported browsers. */
  const haptic = (pattern: number | number[]): void => {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(pattern)
      }
    } catch { /* no-op */ }
  }

  /** Cooldown (ms) of the Dodge Apprentice passive at a given level: 10s at
   *  level 1, −0.5s per level (max level 10 → 5.5s). */
  const dodgeCooldownMs = (level: number): number => Math.max(0, 10 - (level - 1) * 0.5) * 1000

  /** An obstacle the ball can barrel through instead of dying on:
   *  • the Push Force power-up clears small obstacles (box + stone + wall), and
   *  • the permanent Rolling Boulder upgrade lets it roll through boxes.
   *  Both award coins and shatter the prop (see the obstacle handling below).
   *
   *  Takes an `ObstacleKind` and is ONLY ever consulted inside the
   *  `cell.kind === 'obstacle'` branch — so this can never apply to lava
   *  (`kind: 'lava'`) or holes (`kind: 'hole'`). Push Force must NOT clear lava:
   *  lava always kills (or is survived by invuln / Second Chance), never pushed. */
  const isPassableObstacle = (o: ObstacleKind | undefined): boolean =>
    (powerups.isActive('push') && isSmall(o)) ||
    (progress.levelOf('rollingBoulder') > 0 && (o === 'box' || o === 'crate'))

  // ─── Crate-pile (2×2 destructible cluster) ────────────────────────────────
  //
  // A crate-pile occupies four diamonds forming a larger diamond: the bottom
  // (front) anchor cell, the two mid cells flanking it, and the top (back) cell.
  // It behaves exactly like a box — Push Force / Rolling Boulder / invuln smash
  // it, and a bare contact crashes — but as ONE unit: hitting any member bursts
  // the whole pile.

  /** The four diamond cells of a crate-pile, given its bottom-front anchor
   *  (bc, br): bottom, mid-left, mid-right, top. */
  const cratePileCells = (bc: number, br: number): ReadonlyArray<readonly [number, number]> =>
    [[bc, br], [bc - 1, br - 1], [bc + 1, br - 1], [bc, br - 2]] as const

  /** Remove every crate cell of the pile `cell` belongs to and burst it once. */
  const destroyCratePile = (cell: Cell): void => {
    const bc = cell.crateBC ?? cell.c
    const br = cell.crateBR ?? cell.r
    for (const [cc, rr] of cratePileCells(bc, br)) {
      if (game.cells.get(cellKey(cc, rr))?.obstacle === 'crate') game.cells.delete(cellKey(cc, rr))
    }
    // One shatter burst at the bottom-front cell reads as the whole pile bursting.
    emitFx('shatter', bc, br, undefined, 'crate')
  }

  // ─── Procedural generation ────────────────────────────────────────────────

  // Per-cell hazard APPEAR CHANCE `q` — a slower, lower curve (rebalance):
  //   • stages 1 → 20 : 0.05 → 0.14   (gentle ramp; old stage-10 density now at 20)
  //   • stages 20 → 50: flat 0.14     (old stages 11-30 stretched over 20-50)
  //   • stages 50+     : +0.2%/stage up to a 0.17 cap (the old 31+ creep, lower cap)
  // The generator forbids two adjacent hazards, so realised on-field density is
  // q/(1+q): ~12.3% of cells at stage 20, ~14.5% at the 0.17 cap. Endless softens
  // it; the first-ever (onboarding) run halves it; a player stuck on a stage 10+
  // gets the field further thinned per death (see `lateStageObstacleRelief`).
  // Stages 1-2 were laughably empty (an unloseable stage 1 = early dropouts), so
  // they now spawn at stage-3 density — the gentle ramp begins from stage 3.
  const HAZARD_EARLY_END = 0.14    // q at the end of the 1→20 ramp, held flat to 50
  const HAZARD_MAX = 0.17          // far-late-game cap (reached ~stage 65)
  const HAZARD_LATE_PER_STAGE = 0.002
  const stageHazardChance = (stage: number): number => {
    const s = Math.max(1, stage)
    // Floor the density-driving stage at 3 so stages 1 & 2 spawn like stage 3.
    const ds = Math.max(3, s)
    let p: number
    if (ds <= 20) p = 0.05 + (ds - 1) * ((HAZARD_EARLY_END - 0.05) / 19)
    else if (ds <= 50) p = HAZARD_EARLY_END
    else p = Math.min(HAZARD_MAX, HAZARD_EARLY_END + (ds - 50) * HAZARD_LATE_PER_STAGE)
    if (gameMode.value === 'endless') p *= 0.9
    if (isOnboardingRun.value) p *= 0.5
    // Stuck-player relief: thin the field the more they've died on this stage.
    p *= 1 - lateStageObstacleRelief(stage)
    return p
  }

  /** Stage used to drive procedural generation. Campaign uses the player's
   *  stage; endless ramps a pseudo-stage with distance travelled (capped). */
  const genStage = (): number => {
    if (gameMode.value === 'endless') {
      const dist = Math.max(0, -game.genR)
      return Math.min(12, 1 + Math.floor(dist / 30))
    }
    return progress.stage.value
  }

  /** Weighted hazard pick honouring the adaptive spawn director: a hazard kind
   *  that has been killing the player a lot this session is down-weighted so
   *  upcoming runs ease off it (roadmap #8). */
  const pickHazard = (
    pool: Array<{ kind: CellKind; obstacle?: ObstacleKind }>
  ): { kind: CellKind; obstacle?: ObstacleKind } => {
    let total = 0
    const weights = pool.map((p) => {
      const key = hazardKeyOf(p.kind, p.obstacle)
      const deaths = key ? (hazardDeaths.get(key) ?? 0) : 0
      const w = 1 / (1 + deaths * 0.6)
      total += w
      return w
    })
    let roll = Math.random() * total
    for (let i = 0; i < pool.length; i++) {
      roll -= weights[i]!
      if (roll <= 0) return pool[i]!
    }
    return pool[pool.length - 1]!
  }

  /** Hazard types unlocked per stage. Stage 1 introduces only boxes; holes join
   *  at stage 2; boulders/lava/spikes at stage 3 (all but the portal); the wall
   *  block at stage 4. The teleport portal is gated separately (stage 4+). */
  const hazardPool = (stage: number): Array<{ kind: CellKind; obstacle?: ObstacleKind }> => {
    const pool: Array<{ kind: CellKind; obstacle?: ObstacleKind }> = [{ kind: 'obstacle', obstacle: 'box' }]
    if (stage >= 2) pool.push({ kind: 'hole' })
    if (stage >= 3) {
      pool.push({ kind: 'obstacle', obstacle: 'stone' })
      pool.push({ kind: 'lava' })
      pool.push({ kind: 'obstacle', obstacle: 'pyramid' })
    }
    if (stage >= 4) pool.push({ kind: 'obstacle', obstacle: 'wall' })
    return pool
  }

  /** Stage from which the 2×2 crate-pile starts appearing (after walls at 4). */
  const CRATE_PILE_STAGE = 5
  /** Per-row chance to attempt a crate-pile once unlocked — deliberately rare so
   *  the cluster stays a special sight rather than a wall of dodging. */
  const CRATE_PILE_CHANCE = 0.02

  /** Clear a single cell for a crate-pile go-around lane: deletes a deadly hazard
   *  (hole / lava / obstacle) but leaves coins & item boxes. If the cell is part
   *  of ANOTHER crate-pile, the whole of that pile is removed so no invisible
   *  member is left behind. Coins/items are passable, so they never trap. */
  const clearForCrateGoAround = (cc: number, rr: number): void => {
    const k = game.cells.get(cellKey(cc, rr))
    if (!k) return
    if (k.kind === 'obstacle' && k.obstacle === 'crate') {
      const bc = k.crateBC ?? k.c
      const br = k.crateBR ?? k.r
      for (const [x, y] of cratePileCells(bc, br)) game.cells.delete(cellKey(x, y))
    } else if (k.kind === 'hole' || k.kind === 'lava' || k.kind === 'obstacle') {
      game.cells.delete(cellKey(cc, rr))
    }
  }

  /** Try to drop a 2×2 crate-pile with its TOP diamond on row `r`, extending DOWN
   *  into the two already-generated rows below it (r+1, r+2). Returns the top
   *  column on success (so the row generator can keep hazards clear of it), else
   *  -1. The four target cells must be empty; flanking cells are cleared so the
   *  ball always has a way around (preserving the "always solvable" guarantee). */
  const tryPlaceCratePile = (r: number): number => {
    // Keep a 3-column margin from each edge so a go-around lane always exists.
    const cand: number[] = []
    for (let c = 3; c <= C_MAX - 3; c++) if (((c + r) & 1) === 0) cand.push(c)
    for (let i = cand.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[cand[i], cand[j]] = [cand[j]!, cand[i]!]
    }
    for (const c of cand) {
      const bc = c
      const br = r + 2 // bottom-front anchor (two rows below the top)
      const cells = cratePileCells(bc, br)
      if (cells.some(([cc, rr]) => game.cells.has(cellKey(cc, rr)))) continue
      for (const [cc, rr] of cells) {
        game.cells.set(cellKey(cc, rr), { c: cc, r: rr, kind: 'obstacle', obstacle: 'crate', crateBC: bc, crateBR: br })
      }
      // Guarantee a go-around: clear the flank cells whose only safe up-neighbour
      // would otherwise be the pile.
      for (const [cc, rr] of [[c - 2, r + 2], [c + 2, r + 2], [c - 3, r + 1], [c + 3, r + 1]] as const) {
        clearForCrateGoAround(cc, rr)
      }
      return c
    }
    return -1
  }

  /** Generate one row `r` of diamonds (valid `c` share parity with `r`). The
   *  "no two adjacent diamonds both hazardous" rule guarantees the ball always
   *  has at least one safe up-neighbour, so the run is always solvable. */
  const genRow = (r: number): void => {
    const stage = genStage()
    // Onboarding extends the guaranteed-safe runway on the first-ever run.
    const runway = START_RUNWAY + (isOnboardingRun.value ? ONBOARD_RUNWAY_BONUS : 0)
    const safeRunway = r > -runway
    const pHazard = stageHazardChance(stage)
    const pool = hazardPool(stage)
    const portalsAllowed = stage >= 4
    const cols: number[] = []
    for (let c = 0; c <= C_MAX; c++) {
      if (((c + r) & 1) === 0) cols.push(c)
    }
    // Exit-gate planning: as the player nears the campaign goal, stop spawning
    // obstacles in the central lane (final approach) and EVERYTHING beyond the goal
    // (the exit corridor). The ball then auto-rolls cleanly into the gate without
    // any obstacles having to be deleted at the last second (immersion).
    const goal = (gameMode.value === 'campaign' && Number.isFinite(stageTarget.value)) ? stageTarget.value : Infinity
    const tile = -r // this row's tile index (≈ score on entering it)
    const corridorClear = goal !== Infinity && tile > goal                                       // pure floor beyond the goal
    const centerClear = goal !== Infinity && !corridorClear && tile >= goal - EXIT_APPROACH_TILES // clear central lane
    const exitCenter = Math.round(C_MAX / 2)
    // Rare 2×2 crate-pile (stage 5+): commit it first, then keep the row's other
    // hazards clear of its top column so nothing sits adjacent to the pile.
    let pileTopC = -99
    if (!safeRunway && !corridorClear && !centerClear && stage >= CRATE_PILE_STAGE
      && Math.random() < CRATE_PILE_CHANCE * (1 - lateStageObstacleRelief(stage))) {
      pileTopC = tryPlaceCratePile(r)
    }
    let prevHazard = false
    for (const c of cols) {
      // Exit planning: pure floor in the corridor beyond the goal; a clear central
      // lane on the final approach.
      if (corridorClear) continue
      if (centerClear && Math.abs(c - exitCenter) <= 1) { prevHazard = false; continue }
      // Skip the pile's top column and its in-row neighbours (already placed /
      // must stay clear so no hazard ends up adjacent to the crate-pile).
      if (pileTopC >= 0 && Math.abs(c - pileTopC) <= 2) { prevHazard = false; continue }
      let kind: CellKind = 'floor'
      let obstacle: ObstacleKind | undefined
      if (!safeRunway && !prevHazard && Math.random() < pHazard) {
        // Hazard drawn from the stage's unlocked pool (adaptive-weighted).
        const pick = pickHazard(pool)
        kind = pick.kind
        obstacle = pick.obstacle
        // Late game (stage 10+): half the spiky-poles become Liberty Cats.
        if (obstacle === 'pyramid' && stage >= 10 && Math.random() < 0.5) obstacle = 'libertyCat'
        prevHazard = true
      } else {
        prevHazard = false
        if (!safeRunway && portalsAllowed && Math.random() < 0.045) {
          kind = 'portal'
        } else if (!safeRunway && Math.random() < 0.2) {
          kind = 'coin'
        }
      }
      if (kind !== 'floor') {
        game.cells.set(cellKey(c, r), { c, r, kind, obstacle })
      }
    }

    // Item box: place it in the horizontal centre with a guaranteed-clear
    // approach so it's ALWAYS reachable by the diagonal-hop movement — never at
    // the edge, behind a wall, or across a hole the player can't cross.
    if (game.pendingItem && !safeRunway && !corridorClear && !centerClear) {
      const mid = C_MAX >> 1
      // Keep parity valid for this row ((c + r) must be even); nudge off-centre by one if needed.
      const c = ((mid + r) & 1) === 0 ? mid : (Math.random() < 0.5 ? mid - 1 : mid + 1)
      // ~12% of item boxes are "lucky" — a telegraphed rare double-duration drop.
      const lucky = Math.random() < 0.12
      game.cells.set(cellKey(c, r), { c, r, kind: 'item', lucky })
      // Clear the two diamonds the ball can hop onto it from, so there's always a way in.
      game.cells.delete(cellKey(c - 1, r + 1))
      game.cells.delete(cellKey(c + 1, r + 1))
      game.pendingItem = false
      game.itemSpawned += 1
    }

    // Stage 1 (30-tile goal) opens with a long safe runway. On top of the
    // stage-3-level hazard density it now spawns at, guarantee a box to dodge on
    // each of tiles 9, 12 and 15 (≥3 obstacles in the 9-15 window) so the opener
    // reliably teaches dodging right after the runway. Placed
    // outside the normal density/runway rules, with in-row neighbours cleared so
    // it never traps the player (stage 1 has only boxes — always dodgeable).
    if (stage === 1 && (r === -9 || r === -12 || r === -15)) {
      let bc = 2 + Math.floor(Math.random() * (C_MAX - 3)) // 2 .. C_MAX-2
      if (((bc + r) & 1) !== 0) bc += 1
      bc = Math.max(0, Math.min(C_MAX, bc))
      game.cells.delete(cellKey(bc - 2, r))
      game.cells.delete(cellKey(bc + 2, r))
      game.cells.set(cellKey(bc, r), { c: bc, r, kind: 'obstacle', obstacle: 'box' })
    }

    // Stage 2 early reward: a guaranteed item box just past the opening runway
    // (tile 8) — before the normal every-10-tiles cadence — so the player scores
    // a power-up early and finds a reason to keep playing (the stage's first
    // taste of the upgrade loop). Centred with a cleared approach so it's always
    // reachable, like the normal item placement above.
    if (stage === 2 && r === -8) {
      const mid = C_MAX >> 1
      const c = ((mid + r) & 1) === 0 ? mid : (mid + 1 <= C_MAX ? mid + 1 : mid - 1)
      game.cells.set(cellKey(c, r), { c, r, kind: 'item', lucky: false })
      game.cells.delete(cellKey(c - 1, r + 1))
      game.cells.delete(cellKey(c + 1, r + 1))
    }
  }

  const ensureGenerated = (): void => {
    const frontier = Math.floor(game.ballR) - GEN_AHEAD
    while (game.genR > frontier) {
      game.genR -= 1
      genRow(game.genR)
    }
  }

  const cull = (): void => {
    // Despawn only cells that have scrolled past the bottom edge. The number of
    // visible rows below the ball scales with viewport height ÷ tile size
    // (`getRowsBelowBall`, recomputed on resize), so tall portrait screens keep
    // far more rows alive than the old fixed `CULL_BEHIND` — which despawned
    // obstacles/coins while they were still on screen. Floor at CULL_BEHIND so a
    // missing/zero geometry reading can never cull more aggressively than before.
    const behind = Math.ceil(game.ballR) + Math.max(CULL_BEHIND, getRowsBelowBall())
    for (const [k, cell] of game.cells) {
      if (cell.r > behind) game.cells.delete(k)
    }
    game.fx = game.fx.filter((f) => game.clock - f.bornAt < 900)
  }

  // ─── Movement helpers ───────────────────────────────────────────────────

  const isDeadlyKind = (cell: Cell | undefined): boolean => {
    if (!cell) return false
    if (cell.kind === 'hole') return true
    if (cell.kind === 'lava') return true
    if (cell.kind === 'obstacle') return true
    return false
  }

  /** Start the Racer auto-pilot dash from (c, r): a hands-off 5× sprint that
   *  steers a guaranteed-safe path forward for RACER_TILES tiles. */
  const startRacer = (c: number, r: number, tiles: number = RACER_TILES): void => {
    game.racerTilesLeft = tiles
    game.racerExitGuard = 0
    racerActive.value = true
    emitFx('item', c, r, '#ff3df0')
    game.powerupFlashAt = game.clock || 1 // reuse the pickup chromatic pulse
    haptic([10, 20, 10])
    playSound('happy', 0.06)
  }

  /** Pick the dash's next diamond: stay in bounds, prefer the current heading,
   *  swerve to dodge an item box when the other side is clear, and wipe any
   *  hazard / portal on the landing cell so the auto-pilot can never crash. */
  const racerRetarget = (): void => {
    ensureGenerated()
    const r = game.cell.r - 1
    let d = game.dir
    let nc = game.cell.c + d
    if (nc < 0 || nc > C_MAX) { d = (-d) as 1 | -1; nc = game.cell.c + d }
    const altC = game.cell.c - d
    const kindAt = (cc: number): CellKind | undefined => game.cells.get(cellKey(cc, r))?.kind
    // Prefer not to vacuum up item boxes during the dash — swerve if the other
    // diagonal is a valid in-bounds tile.
    if (kindAt(nc) === 'item' && altC >= 0 && altC <= C_MAX && kindAt(altC) !== 'item') {
      d = (-d) as 1 | -1
      nc = altC
    }
    game.dir = d
    game.nextDir = d
    game.target = { c: nc, r }
    // Clear anything lethal/blocking on the landing cell so the sprint is safe.
    const k = kindAt(nc)
    if (k && k !== 'floor' && k !== 'coin') {
      const lc = game.cells.get(cellKey(nc, r))
      // A crate-pile must go as a whole, or stray invisible members linger.
      if (lc?.obstacle === 'crate') destroyCratePile(lc)
      else game.cells.delete(cellKey(nc, r))
    }
  }

  /** Resolve the next target diamond from the current cell, honouring the
   *  queued heading, edge bounce, and the Dodge-Master auto-avoid. */
  const retarget = (): void => {
    // Hands-off Racer dash steers itself along a guaranteed-safe path.
    if (game.racerTilesLeft > 0 || game.racerExitGuard > 0) { racerRetarget(); return }
    const oldDir = game.dir
    const playerFlipped = game.nextDir !== oldDir // the player tapped this hop
    game.dir = game.nextDir
    let tc = game.cell.c + game.dir
    if (tc < 0 || tc > C_MAX) {
      game.dir = (-game.dir) as 1 | -1
      game.nextDir = game.dir
      tc = game.cell.c + game.dir
    }
    const tr = game.cell.r - 1

    // Auto-dodge: if the chosen diamond is deadly, swing to the other neighbour
    // when it's safe (and in-bounds). Two sources can power a dodge —
    //   • the timed Dodge-Master power-up (free, always dodges while active), and
    //   • the permanent Dodge Apprentice upgrade (cooldown-gated; consumes a
    //     charge per dodge, recharging faster at higher levels).
    let dodged = false
    const apprenticeLevel = progress.levelOf('dodgeApprentice')
    const apprenticeReady = apprenticeLevel > 0 && game.clock >= game.dodgeReadyAt
    if (powerups.isActive('dodge') || apprenticeReady) {
      const chosen = game.cells.get(cellKey(tc, tr))
      if (isDeadlyKind(chosen)) {
        const altC = game.cell.c - game.dir
        if (altC >= 0 && altC <= C_MAX && !isDeadlyKind(game.cells.get(cellKey(altC, tr)))) {
          game.dir = (-game.dir) as 1 | -1
          game.nextDir = game.dir
          tc = altC
          // Only the apprentice pays a cooldown — the power-up dodge is free.
          if (!powerups.isActive('dodge')) {
            game.dodgeReadyAt = game.clock + dodgeCooldownMs(apprenticeLevel)
          }
          emitFx('sparkle', altC, tr, '#37e0a0')
          playSound('dodge', 0.05)
          dodged = true
          bumpCombo(altC, tr) // risk-combo: an auto-dodge off a lethal cell
        }
      }
    }

    // Risk-combo: a last-tile turn-AWAY — the player flipped and the cell they'd
    // have rolled into without it was lethal, while the new one is safe.
    if (playerFlipped && !dodged) {
      const avoidedC = game.cell.c + oldDir
      if (avoidedC >= 0 && avoidedC <= C_MAX
        && isDeadlyKind(game.cells.get(cellKey(avoidedC, tr)))
        && !isDeadlyKind(game.cells.get(cellKey(tc, tr)))) {
        bumpCombo(tc, tr)
      }
    }
    game.target = { c: tc, r: tr }
  }

  /** Teleport the ball to a random valid diamond several rows ahead, clearing
   *  the landing zone so it's a fair touchdown. The step loop re-targets from
   *  the new cell after this returns. */
  const teleportForward = (fromC: number, fromR: number): void => {
    emitFx('portal', fromC, fromR, '#9a6bff')
    const jump = 5 + Math.floor(Math.random() * 4) // 5..8 rows forward
    const destR = fromR - jump
    let destC = Math.floor(Math.random() * (C_MAX + 1))
    if (((destC + destR) & 1) !== 0) destC += destC < C_MAX ? 1 : -1 // keep parity valid
    destC = Math.max(0, Math.min(C_MAX, destC))
    ensureGenerated()
    // Clear the landing diamond and its up-neighbours so the player doesn't
    // teleport straight into a hazard.
    for (const [dc, dr] of [[0, 0], [-1, -1], [1, -1]] as const) {
      game.cells.delete(cellKey(destC + dc, destR + dr))
    }
    game.cell = { c: destC, r: destR }
    game.progress = 0
    // Slow time for a beat so the player can find where they landed.
    game.teleportSlowUntil = game.clock + TELEPORT_SLOW_MS
    emitFx('portal', destC, destR, '#9a6bff')
    playSound('gravity', 0.06)
  }

  const onEnterCell = (c: number, r: number): void => {
    score.value += 1
    // Queue an item box for the upcoming generation every 10 tiles travelled.
    if (score.value % 10 === 0) game.pendingItem = true
    // Endless: bank the best LIVE as it's beaten (debounced disk write, no flush
    // per tile) so the high score survives ANY exit — a Retry from the
    // ContinueModal, a tab close, an ad, or a crash before `die()` runs. `die()`
    // still does a final flush. (Campaign best is recorded on the result screen.)
    if (gameMode.value === 'endless') recordEndlessBest(false)
    const cell = game.cells.get(cellKey(c, r))

    // Win check. Campaign: reaching the tile goal kicks off the exit-gate
    // sequence (auto-roll through the archway) which calls `win()` when it
    // finishes. Endless has an Infinity goal, so it never reaches here.
    if (score.value >= stageTarget.value) {
      beginExit()
      return
    }

    // Racer dash: scoop coins, skip/clear everything else, count down. Once the
    // 25 tiles are done, keep clearing a short runway so the player resumes on
    // safe ground (the requested ≥2 free exit tiles).
    if (game.racerTilesLeft > 0 || game.racerExitGuard > 0) {
      if (cell) {
        if (cell.kind === 'coin') collectCoin(cell)
        else if (cell.kind === 'obstacle') {
          // The dash plows through obstacles — shatter them (juice) AND emit the
          // 'shatter' FX so the on-screen boulders' googly eyes get frightened,
          // same as a Push Force / invuln smash. A crate-pile bursts as one unit.
          if (cell.obstacle === 'crate') destroyCratePile(cell)
          else { emitFx('shatter', c, r, undefined, cell.obstacle); game.cells.delete(cellKey(c, r)) }
        } else if (cell.kind !== 'floor') game.cells.delete(cellKey(c, r))
      }
      if (game.racerTilesLeft > 0) {
        game.racerTilesLeft -= 1
        if (game.racerTilesLeft === 0) game.racerExitGuard = RACER_EXIT_RUNWAY
      } else {
        game.racerExitGuard -= 1
      }
      return
    }

    if (!cell || cell.kind === 'floor') return

    const invuln = powerups.isActive('invuln')

    if (cell.kind === 'portal') {
      teleportForward(c, r)
      return
    }
    if (cell.kind === 'coin') {
      collectCoin(cell)
      return
    }
    if (cell.kind === 'item') {
      grantItem(cell)
      return
    }
    if (cell.kind === 'hole') {
      if (invuln) { emitFx('sparkle', c, r, '#ffd23f'); return }
      // A held Second Chance lets the angel wings carry the ball over the gap
      // once (matching the upgrade description), then breaks — same consume path
      // as an obstacle/lava save, just gliding across instead of falling in.
      if (surviveWithSecondChance(c, r)) return
      startDrop()
      return
    }
    if (cell.kind === 'lava') {
      if (invuln) { emitFx('sparkle', c, r, '#ffd23f'); return }
      if (surviveWithSecondChance(c, r)) return
      game.exploded = true
      lastKillerKind = 'lava'
      die('crash')
      return
    }
    if (cell.kind === 'obstacle') {
      const isCrate = cell.obstacle === 'crate'
      if (invuln) {
        // Tear the obstacle apart (matches the ball's death-shatter language). A
        // crate-pile bursts as one unit (all four cells).
        if (isCrate) destroyCratePile(cell)
        else { emitFx('shatter', c, r, undefined, cell.obstacle); game.cells.delete(cellKey(c, r)) }
        emitFx('pop', c, r, '#ffd23f')
        awardInstantCoins(c, r, 3)
        playSound('shrapnel', 0.06)
        return
      }
      if (isPassableObstacle(cell.obstacle)) {
        if (isCrate) destroyCratePile(cell)
        else { emitFx('shatter', c, r, undefined, cell.obstacle); game.cells.delete(cellKey(c, r)) }
        emitFx('push', c, r, '#ff7a3f')
        awardInstantCoins(c, r, 3)
        playSound('shrapnel', 0.06)
        return
      }
      if (surviveWithSecondChance(c, r)) return
      game.exploded = true
      lastKillerKind = hazardKeyOf('obstacle', cell.obstacle)
      die('crash')
    }
  }

  /** Spend a held Second Chance to survive a lethal obstacle/lava hit: clear the
   *  hazard + its up-neighbours so the ball keeps rolling, and start the
   *  opacity-blink window. Returns false (doing nothing) when none is held. */
  const surviveWithSecondChance = (c: number, r: number): boolean => {
    if (!game.secondChance) return false
    game.secondChance = false
    // Clear the sticky pre-bought flag too: the shield is spent, so the player
    // must purchase another before it arms a future run.
    progress.consumeStartSecondChance()
    game.secondChanceBlinkUntil = game.clock + SECOND_CHANCE_BLINK_MS
    // Signal the renderer to tear the wings apart (same shatter language as the
    // ball/obstacle death). A changing non-zero timestamp is the edge trigger.
    game.wingsBreakAt = game.clock || 1
    for (const [dc, dr] of [[0, 0], [-1, -1], [1, -1]] as const) {
      game.cells.delete(cellKey(c + dc, r + dr))
    }
    emitFx('sparkle', c, r, '#37e0a0')
    triggerShake('small')
    playSound('barricade', 0.06)
    bumpCombo(c, r) // risk-combo: survived a fatal hit on the Second Chance wings
    return true
  }

  /** 1.2× while the stage-clear coin boon is active for this stage (roadmap #13);
   *  stacks multiplicatively with the result-screen 2× rewarded button. */
  const coinMult = (): number => (coinBoostActive ? 1.2 : 1)

  /** Spawn `n` coins at (c, r) that fly straight into the run tally, exactly
   *  like a grid-coin pickup. Used when a destructible obstacle is cleared. */
  const awardInstantCoins = (c: number, r: number, n: number): void => {
    coinsThisRun.value += Math.round(n * coinMult())
    for (let i = 0; i < n; i++) emitFx('coin', c, r, '#ffd23f')
    playCoinSound()
  }

  /** Reward a close call: bump the risk-combo one step (capped) and refresh its
   *  hot-streak timer. A small golden sparkle marks the moment. No reward when
   *  there was no real risk — invuln (passes through anything), Push Force (clears
   *  the obstacle for free), or a Racer dash (free auto-piloted tiles). */
  const bumpCombo = (c: number, r: number): void => {
    if (powerups.isActive('invuln') || powerups.isActive('push')) return
    if (game.racerTilesLeft > 0 || game.racerExitGuard > 0) return
    combo.value = Math.min(COMBO_MAX, +(combo.value + COMBO_STEP).toFixed(2))
    lastComboAt = game.clock
    emitFx('sparkle', c, r, '#ffd23f')
  }

  const collectCoin = (cell: Cell): void => {
    if (cell.collected) return
    cell.collected = true
    // Coins are MULTIPLIED by the current risk-combo but no longer FEED it (the
    // combo only climbs on close calls — see `bumpCombo`).
    const base = upgradedValue('coinValue') * coinMult()
    const value = Math.max(1, Math.round(base * combo.value))
    // Coins are tallied for the run but NOT banked to the wallet here — they're
    // granted on the win/lose screen with a CoinExplosion (see EpicrollaScene).
    coinsThisRun.value += value
    emitFx('coin', cell.c, cell.r, '#ffd23f')
    game.cells.delete(cellKey(cell.c, cell.r))
    playCoinSound()
  }

  const grantItem = (cell: Cell): void => {
    game.cells.delete(cellKey(cell.c, cell.r))
    itemsThisRun.value += 1
    playSound('level-up', 0.07)
    triggerShake('small')
    const lucky = cell.lucky === true
    const racerIdle = game.racerTilesLeft <= 0 && game.racerExitGuard <= 0
    // GOLDEN (lucky) box → always a long 40-tile Racer dash. The telegraphed rare
    // drop reliably pays off with the big hands-off sprint.
    if (lucky && racerIdle) {
      startRacer(cell.c, cell.r, RACER_TILES_GOLDEN)
      return
    }
    // Racer: a hands-off 5× dash. Rolled FIRST (before the Second-Chance branch)
    // so it isn't starved by it. Non-lucky boxes only; never while one is already
    // running. ~15% chance — rare enough to feel special, common enough to see.
    if (!lucky && racerIdle && Math.random() < 0.15) {
      startRacer(cell.c, cell.r)
      return
    }
    // A LUCKY box always rolls a power-up — at DOUBLE duration — and never the
    // Second Chance, so the telegraphed rare drop reliably pays off (roadmap #12).
    if (!lucky && !game.secondChance && Math.random() < 0.25) {
      game.secondChance = true
      emitFx('item', cell.c, cell.r, '#37e0a0')
      return
    }
    const type = powerups.randomType()
    powerups.activate(type, game.clock, lucky ? 2 : 1)
    emitFx('item', cell.c, cell.r, lucky ? '#ffd23f' : '#ffffff')
    game.powerupFlashAt = game.clock || 1 // brief chromatic pickup pulse (#14)
    haptic(15)
    if (lucky) playSound('happy', 0.05)
  }

  /** Death Magnet upgrade: on a fatal hit, sweep every coin within a 4-tile
   *  radius (all directions, incl. diagonal) into the run tally — banking coins
   *  that would otherwise be lost. A one-shot magnet fired the instant the game
   *  knows the player is dying with no Second Chance left. */
  const deathCoinSweep = (): void => {
    if (progress.levelOf('deathMagnet') <= 0) return
    const R = 4
    const r2 = R * R
    for (const cell of game.cells.values()) {
      if (cell.kind !== 'coin' || cell.collected) continue
      const dc = (cell.c - game.ballC) * 0.5
      const dr = cell.r - game.ballR
      if (dc * dc + dr * dr <= r2) collectCoin(cell)
    }
  }

  /** Coin Magnet: pull in nearby coins each frame. The active reach is the
   *  larger of the timed Magnet power-up's upgraded range and the permanent
   *  Auto-Collect upgrade's fixed 1-tile reach (owned → always-on, no power-up). */
  const runMagnet = (): void => {
    const magnetReach = powerups.isActive('magnet') ? upgradedValue('magnetRange') : 0
    const autoReach = progress.levelOf('autoCollect') > 0 ? 1 : 0
    const range = Math.max(magnetReach, autoReach)
    if (range <= 0) return
    const r2 = range * range
    for (const cell of game.cells.values()) {
      if (cell.kind !== 'coin' || cell.collected) continue
      const dc = (cell.c - game.ballC) * 0.5
      const dr = cell.r - game.ballR
      if (dc * dc + dr * dr <= r2) collectCoin(cell)
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  const resetForStage = (): void => {
    game.cells.clear()
    game.fx = []
    const startC = 2 * Math.round(C_MAX / 4) // even, near centre
    game.cell = { c: startC, r: 0 }
    game.dir = 1
    game.nextDir = 1
    game.progress = 0
    game.ballC = startC
    game.ballR = 0
    game.speed = startSpeedForStage(progress.stage.value)
    game.clock = 0
    game.runStartClock = 0
    game.genR = 1
    game.itemSpawned = 0
    game.pendingItem = false
    game.dropping = false
    game.dropClock = 0
    game.exploded = false
    game.teleportSlowUntil = 0
    // Consume any stage-clear boon chosen on the previous win (roadmap #13).
    // The 'secondChance' boon arms the sticky start-shield (overwriting the
    // buyable perk); 'coinBoost' enables the 1.2× for THIS stage; 'startPowerup'
    // is granted in `begin`. Each boon lasts exactly the one stage it precedes.
    coinBoostActive = pendingBoon.value === 'coinBoost'
    if (pendingBoon.value === 'secondChance') progress.armStartSecondChance()
    pendingStartPowerup = pendingBoon.value === 'startPowerup' ? powerups.randomType() : null
    pendingBoon.value = null
    // A pre-bought Second Chance arms the run: start with the shield (and its
    // angel wings) held. It persists across runs until one is actually spent.
    game.secondChance = progress.startSecondChance.value
    game.secondChanceBlinkUntil = 0
    game.dodgeReadyAt = 0 // every run starts with one Dodge Apprentice charge ready
    game.wingsBreakAt = 0 // clear any pending wings-shatter trigger
    game.powerupFlashAt = 0 // clear any pending pickup pulse
    combo.value = 1 // reset the risk-combo for the fresh stage
    lastComboAt = -Infinity
    game.racerTilesLeft = 0 // clear any Racer dash for the fresh stage
    game.racerExitGuard = 0
    racerActive.value = false
    game.exiting = false // clear any stage-clear exit sequence
    exitingActive.value = false
    game.exitStartClock = 0
    // Reset the music tempo to this stage's floor (0.60× early, 1.0× from st.8).
    setMusicRate(progress.stage.value >= 8 ? 1.0 : 0.6)
    powerups.clear()
    score.value = 0
    coinsThisRun.value = 0
    itemsThisRun.value = 0
    lastWinReward.value = 0
    lastKillerKind = null
    gameResult.value = ''
    lossCause.value = ''
    survivalMs.value = 0
    // Endless has no tile goal — a sentinel target the win-check never reaches.
    stageTarget.value = gameMode.value === 'endless'
      ? Number.POSITIVE_INFINITY
      : rubberBandedTarget(progress.stage.value)
    game.phase = 'idle'
    phase.value = 'idle'
    retarget()
    ensureGenerated()
    // Play the falling-ball "ready!" bounce as the fresh stage settles in.
    triggerBallDropIn()
  }

  const begin = (): void => {
    if (phase.value === 'playing') return
    game.phase = 'playing'
    phase.value = 'playing'
    game.runStartClock = game.clock
    // Stage-clear 'startPowerup' boon: kick the run off with a free power-up.
    if (pendingStartPowerup) {
      powerups.activate(pendingStartPowerup, game.clock)
      pendingStartPowerup = null
    }
    progress.recordGamePlayed()
    awardAttempt() // every run grants the battle-pass participation XP
  }

  const flip = (): void => {
    if (phase.value !== 'playing') return
    // No control during the Racer dash or the stage-clear exit roll.
    if (game.racerTilesLeft > 0 || game.racerExitGuard > 0 || game.exiting) return
    // Queue the turn AWAY from the committed heading (`-game.dir`) rather than
    // toggling the pending value. `dir` only changes when a hop commits
    // (retarget), so this is stable for the whole hop and a *second* tap before
    // the ball reaches the next tile — a double-tap to be sure it registered, an
    // OS key-repeat, or a bouncy touch — just re-asserts the same turn instead
    // of toggling `nextDir` back to straight and silently eating the turn (the
    // "I heard the flip but the ball rolled straight on" bug). Idempotent: once
    // the turn is queued, further taps this hop are a no-op (no re-trigger, no
    // duplicate swap SFX). For a single tap per tile this matches the old toggle
    // exactly; it only removes the same-hop cancellation.
    const turned = (-game.dir) as 1 | -1
    if (game.nextDir === turned) return
    game.nextDir = turned
    playSound('anchor-swap', 0.035, 1 + (Math.random() - 0.5) * 0.12)
  }

  /** Begin sinking the ball into the hole it just entered. Movement freezes;
   *  `step` advances `dropClock` and calls `die('hole')` once the sink finishes,
   *  so the player sees the ball fall into the void before the lose flow runs. */
  const startDrop = (): void => {
    if (game.dropping) return
    game.dropping = true
    game.dropClock = 0
    game.progress = 0
    lastKillerKind = 'hole'
    // Falling into a hole — the gravity "drop" cue (same as the portal pull).
    playSound('gravity', 0.06)
  }

  const die = (cause: LossCause): void => {
    if (phase.value !== 'playing') return
    game.phase = 'dead'
    phase.value = 'dead'
    gameResult.value = 'lose'
    lossCause.value = cause
    combo.value = 1 // a hit breaks the risk-combo
    lastComboAt = -Infinity
    game.racerTilesLeft = 0 // end any Racer dash on death
    game.racerExitGuard = 0
    racerActive.value = false
    // Rubber band: record this failed attempt (per stage). Early stages (1-3) use
    // it to lower the tile goal; stage 10+ uses it to thin obstacles + slow the
    // ball (see the late-stage relief helpers). Session-only; campaign-only.
    if (gameMode.value === 'campaign') {
      const s = progress.stage.value
      stageFailCounts.set(s, (stageFailCounts.get(s) ?? 0) + 1)
    }
    // Adaptive spawn director: log which hazard killed the player this run.
    if (lastKillerKind) hazardDeaths.set(lastKillerKind, (hazardDeaths.get(lastKillerKind) ?? 0) + 1)
    markOnboarded()
    // Death Magnet: bank nearby coins on the way out (no-op unless owned).
    deathCoinSweep()
    haptic([18, 40, 18]) // hit haptic (#14)
    survivalMs.value = game.clock - game.runStartClock
    // No collision FX: a hole death plays the ball's sink animation, a crash
    // plays the tear-apart (ball-shatter) animation — both stand on their own.
    triggerShake('big')
    // Hole death gets the soft "fell in" chime; an obstacle crash tears the
    // ball apart — fire a random plastic-torn variant so repeated deaths vary.
    if (cause === 'hole') playSound('celebration-1', 0.08)
    else playRandomVariant('plastic-torn', 2, 0.09)
    // Endless tracks its OWN best (tiles); campaign updates the personal best.
    if (gameMode.value === 'endless') recordEndlessBest()
    else progress.recordScore(score.value)
  }

  /** Mark the one-time onboarding assist as consumed once the first run ends. */
  const markOnboarded = (): void => {
    if (!isOnboardingRun.value) return
    isOnboardingRun.value = false
    setState(ONBOARDED_KEY, true)
    void flushSaveNow()
  }

  /** Persist a new endless best (tiles) if this run beat it. `flush` forces an
   *  immediate disk write (used on death); the live per-tile calls pass false so
   *  they only update the in-memory blob + schedule the debounced write — the
   *  best is still safe because the blob is what every save path reads. */
  const recordEndlessBest = (flush = true): void => {
    if (score.value <= bestEndless.value) return
    bestEndless.value = score.value
    setState(BEST_ENDLESS_KEY, score.value)
    if (flush) void flushSaveNow()
  }

  /** Revive at the current spot: clear the hazard that killed the player and
   *  its immediate up-neighbours so they get a fair restart. */
  const revive = (): void => {
    const { c, r } = game.cell
    for (const [dc, dr] of [[0, 0], [-1, -1], [1, -1], [-2, 0], [2, 0]] as const) {
      game.cells.delete(cellKey(c + dc, r + dr))
    }
    game.progress = 0
    game.dropping = false
    game.dropClock = 0
    game.exploded = false
    game.teleportSlowUntil = 0
    game.secondChanceBlinkUntil = 0
    game.dodgeReadyAt = 0 // refresh the dodge charge on revive
    game.phase = 'playing'
    phase.value = 'playing'
    gameResult.value = ''
    lossCause.value = ''
    powerups.activate('invuln', game.clock) // brief mercy invulnerability
    retarget()
  }

  const win = (): void => {
    game.phase = 'won'
    phase.value = 'won'
    gameResult.value = 'win'
    survivalMs.value = game.clock - game.runStartClock
    const survivalSec = survivalMs.value / 1000
    const reward = Math.round(score.value * 0.5 + survivalSec * 2 + progress.stage.value * 10)
    lastWinReward.value = reward
    // Reward coins are banked on the win screen (with the CoinExplosion), not here.
    progress.recordScore(score.value)
    progress.advanceStage()
    markOnboarded() // a first run that ends in a win also consumes onboarding
    haptic([30, 30, 30, 30, 60]) // stage-clear celebration haptic (#14)
    playSound('celebration-2', 0.09)
    triggerShake('strong')
  }

  // ─── Stage-clear exit-gate sequence ───────────────────────────────────────

  /** Begin the campaign stage-clear sequence: take control away, spawn the exit
   *  gate a few rows ahead, and clear the corridor so the ball can auto-roll
   *  cleanly through the archway. `win()` fires when the roll completes. */
  const beginExit = (): void => {
    if (game.exiting) return
    game.exiting = true
    exitingActive.value = true
    game.exitStartClock = game.clock
    game.exitFromC = game.ballC
    game.exitFromR = game.ballR
    game.exitGateC = Math.round(C_MAX / 2)                // centre the arch on the grid
    // Spawn far enough ahead that the gate clears the TOP edge on every viewport
    // (tall portrait fits ~2–3× more rows above the ball than landscape), so it
    // scrolls into view from above instead of popping in mid-screen. Falls back
    // to the fixed minimum on short viewports where few rows fit above the ball.
    const rowsAhead = Math.max(EXIT_GATE_ROWS_AHEAD, getRowsAboveBall() + EXIT_GATE_MARGIN_ROWS)
    game.exitGateR = Math.round(game.ballR) - rowsAhead
    // End any Racer dash — the victory roll owns the wheel now.
    game.racerTilesLeft = 0
    game.racerExitGuard = 0
    racerActive.value = false
    // Make sure the corridor + gate rows exist. They were generated obstacle-free
    // by `genRow`'s exit planning (everything beyond the goal is pure floor), so
    // NOTHING is deleted here — the ball rolls a naturally clean corridor into the
    // gate instead of obstacles vanishing at the last second.
    ensureGenerated()
    haptic([20, 30, 20])
    playSound('barricade', 0.06) // win sting plays in win()
  }

  /** Cubic ease-in-out for the victory roll. */
  const easeInOut = (t: number): number =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

  /** Drive the exit roll each frame: centre on the arch column, roll up to and a
   *  touch PAST the archway (so the renderer occludes the ball behind the wall),
   *  then hand off to `win()`. */
  const stepExit = (): void => {
    const t = Math.min(1, (game.clock - game.exitStartClock) / EXIT_SEQUENCE_MS)
    const e = easeInOut(t)
    game.ballC = game.exitFromC + (game.exitGateC - game.exitFromC) * Math.min(1, e * 1.4)
    const targetR = game.exitGateR - 0.5 // 0.5 row past the threshold = inside the doorway
    game.ballR = game.exitFromR + (targetR - game.exitFromR) * e
    if (t >= 1) { game.exiting = false; win() }
  }

  // ─── Per-frame step ───────────────────────────────────────────────────────

  /** Advance the simulation by `dtMs`. `dtMs` is already pause-gated by the
   *  scene's RAF loop. */
  const step = (dtMs: number): void => {
    const dt = Math.min(dtMs, 50) / 1000 // clamp to avoid tunnelling on stalls
    game.clock += dtMs

    if (phase.value !== 'playing') {
      // Won: leave the ball where the exit roll parked it — inside the archway
      // (set by stepExit), occluded behind the gate wall. Snapping it back to
      // its logical cell here would teleport it to mid-field for the post-win
      // beat (now visible because the ad/result screen no longer covers the
      // scene instantly). It only resets on the next stage via resetForStage.
      // Idle/dead still pin the float render pos to the ball's cell.
      if (phase.value !== 'won') {
        game.ballC = game.cell.c
        game.ballR = game.cell.r
      }
      return
    }

    // Sinking into a hole: hold the ball on the hole cell while it drops, then
    // register the death once the fall completes.
    if (game.dropping) {
      game.dropClock += dtMs
      game.ballC = game.cell.c
      game.ballR = game.cell.r
      if (game.dropClock >= DROP_MS) die('hole')
      return
    }

    // Stage-clear: the ball auto-rolls through the exit gate (no normal movement).
    if (game.exiting) { stepExit(); return }

    powerups.update(game.clock)

    // Speed. Campaign: a per-stage starting speed that accelerates as the player
    // nears the tile goal (stages 1-5 ramp a gentle +30%; stage 6+ +66%).
    // Endless: a gentle distance ramp with no goal (roadmap #9).
    let speed: number
    if (gameMode.value === 'endless') {
      // Endless distance ramp, piecewise so speed keeps creeping up over a long
      // run instead of flat-lining early (the old `min(0.6, tiles*0.006)` capped
      // at +60% by tile 100, so tiles 200-800 all felt identical):
      //   • 0-200 tiles  : +0% → +60%   (the original early ramp)
      //   • 200-500 tiles: +60% → +80%  (another +20% over this band)
      //   • 500-1000 tiles: +80% → +90% (another +10% over this band)
      //   • 1000+ tiles  : held at +90%
      const tiles = score.value
      let ramp: number
      if (tiles <= 200) ramp = (tiles / 200) * 0.6
      else if (tiles <= 500) ramp = 0.6 + ((tiles - 200) / 300) * 0.2
      else if (tiles <= 1000) ramp = 0.8 + ((tiles - 500) / 500) * 0.1
      else ramp = 0.9
      speed = Math.min(MAX_SPEED, BASE_SPEED * (1 + ramp))
    } else {
      const stage = progress.stage.value
      const startSpeed = startSpeedForStage(stage)
      const frac = Math.min(1, Math.max(0, score.value / Math.max(1, stageTarget.value)))
      const rampMax = stage <= RAMP_KNEE_STAGE ? EARLY_STAGE_RAMP : LATE_STAGE_RAMP
      speed = Math.min(MAX_SPEED, startSpeed * (1 + rampMax * frac))
      // Stuck-player relief: slow the ball the more they've died on this stage 10+.
      speed *= 1 - lateStageSpeedRelief(stage)
    }
    // The first-ever run rolls slower so newcomers can find the controls.
    if (isOnboardingRun.value) speed *= 0.8
    // Difficulty: Easy −20% (more reaction time), Medium ×1, Hard +10%.
    speed *= difficultySpeedFactor()
    if (powerups.isActive('slowmo')) speed *= 0.5
    if (game.clock < game.teleportSlowUntil) speed *= TELEPORT_SLOW_FACTOR
    // Racer dash overrides everything with a flat 5× sprint (ignores slow-mo).
    const racing = game.racerTilesLeft > 0 || game.racerExitGuard > 0
    if (racing) {
      const stageBase = startSpeedForStage(progress.stage.value)
      speed = stageBase * RACER_SPEED_MULT
    }
    racerActive.value = racing
    game.speed = speed
    // Risk-combo cools off after a quiet spell with no close call (keep it hot
    // with daring play).
    if (combo.value > 1 && game.clock - lastComboAt > COMBO_WINDOW_MS) {
      combo.value = 1
    }
    // Dynamic music tempo: modulate the track's playback rate from the ball's
    // ACTUAL current speed (which already folds in slow-mo, teleport slow and
    // difficulty, so those naturally drag the beat down). Below stage 8 the beat
    // sits low (0.60×) and ramps to 1.5×; from stage 8 it starts at full tempo
    // (1.0×) and pushes to 1.75× at top speed.
    {
      const frac = Math.max(0, Math.min(1, speed / MAX_SPEED))
      const lateGame = genStage() >= 8
      const floor = lateGame ? 1.0 : 0.6
      const ceil = lateGame ? 1.75 : 1.5
      setMusicRate(floor + frac * (ceil - floor))
    }
    survivalMs.value = game.clock - game.runStartClock

    game.progress += speed * dt

    // Pre-collision: if the next diamond holds a lethal obstacle (one not
    // bypassed by invuln or a push-able small obstacle), blow up at the midpoint
    // of the hop instead of sliding onto it.
    const tcell = game.cells.get(cellKey(game.target.c, game.target.r))
    const lethalObstacle = tcell?.kind === 'obstacle'
      && !powerups.isActive('invuln')
      && !isPassableObstacle(tcell.obstacle)
      && !racing // the dash pre-clears its path; never blow up mid-Racer
    if (lethalObstacle && game.progress >= 0.5) {
      // A held Second Chance clears the obstacle and lets the ball roll on;
      // otherwise it blows up at the midpoint of the hop.
      if (!surviveWithSecondChance(game.target.c, game.target.r)) {
        game.progress = 0.5
        game.ballC = game.cell.c + (game.target.c - game.cell.c) * 0.5
        game.ballR = game.cell.r + (game.target.r - game.cell.r) * 0.5
        game.exploded = true
        die('crash')
        return
      }
    }

    // Commit as many diamonds as we crossed this frame.
    let guard = 0
    while (game.progress >= 1 && phase.value === 'playing' && guard++ < 16) {
      game.progress -= 1
      game.cell = { ...game.target }
      onEnterCell(game.cell.c, game.cell.r)
      if (phase.value !== 'playing' || game.dropping) break
      retarget()
      ensureGenerated()
    }

    // The ball just dropped into a hole this frame: lock it there and let the
    // drop animation take over next frame.
    if (game.dropping) {
      game.ballC = game.cell.c
      game.ballR = game.cell.r
      return
    }

    // Smoothed render position.
    game.ballC = game.cell.c + (game.target.c - game.cell.c) * game.progress
    game.ballR = game.cell.r + (game.target.r - game.cell.r) * game.progress

    runMagnet()
    cull()
  }

  /** DEV/CHEAT: drop a normal item box 1 tile ahead and a GOLDEN (lucky) box 4
   *  tiles ahead, both on the ball's projected (no-input) path, with cleared
   *  approaches so they're reachable. Used to test the Racer dash quickly. */
  const spawnTestItemBoxes = (): void => {
    // Allowed from the idle (menu) screen too, not just mid-run, so you can set
    // up the test BEFORE starting — the boxes sit on already-generated rows and
    // persist into the run (begin() doesn't regenerate). No-op once dead/won.
    if (phase.value !== 'idle' && phase.value !== 'playing') return
    // Make sure the rows we're about to place on actually exist.
    ensureGenerated()
    // Walk the path the ball would take with no taps: each hop is one row up and
    // one column in the current heading, bouncing off the field edges.
    let c = game.cell.c
    let r = game.cell.r
    let d = game.dir
    for (let step = 1; step <= 4; step++) {
      if (c + d < 0 || c + d > C_MAX) d = (-d) as 1 | -1
      c += d
      r -= 1
      if (step === 1 || step === 4) {
        const lucky = step === 4
        game.cells.set(cellKey(c, r), { c, r, kind: 'item', lucky })
        // Clear the two diamonds the ball can hop onto it from + the cell itself.
        game.cells.delete(cellKey(c - 1, r + 1))
        game.cells.delete(cellKey(c + 1, r + 1))
      }
    }
  }

  /** DEV/CHEAT: drop a 2×2 crate-pile a few rows ahead of the ball so the new
   *  cluster can be eyeballed without waiting on its rare spawn roll. */
  const spawnTestCratePile = (): void => {
    if (phase.value !== 'idle' && phase.value !== 'playing') return
    ensureGenerated()
    const br = game.cell.r - 6 // bottom-front anchor, a few rows ahead
    let bc = Math.max(3, Math.min(C_MAX - 2, game.cell.c))
    if (((bc + br) & 1) !== 0) bc += 1
    for (const [cc, rr] of cratePileCells(bc, br)) {
      game.cells.set(cellKey(cc, rr), { c: cc, r: rr, kind: 'obstacle', obstacle: 'crate', crateBC: bc, crateBR: br })
    }
  }

  return {
    // reactive
    phase,
    score,
    gameResult,
    lossCause,
    coinsThisRun,
    itemsThisRun,
    lastWinReward,
    stageTarget,
    survivalMs,
    combo,
    activePowerup: powerups.active,
    // control
    resetForStage,
    begin,
    flip,
    step,
    die,
    revive,
    spawnTestItemBoxes,
    spawnTestCratePile,
    // helpers for the scene
    powerupRemainingMs: (): number => powerups.remainingMs(game.clock),
    isPowerupActive: (t: PowerupType): boolean => powerups.isActive(t),
    clock: (): number => game.clock
  }
}

export default useEpicGame
