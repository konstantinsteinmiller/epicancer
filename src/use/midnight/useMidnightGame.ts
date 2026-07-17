// ─── The run orchestrator ──────────────────────────────────────────────────
//
// Owns the night: which page you're on, how long you have, how fast the whole
// thing is accelerating, and how many hearts you have left. It knows nothing
// about HOW any micro-game plays — only that one exists, that it takes a few
// seconds, and that it ends in a win or a loss.
//
// The cycle (GDD §3):
//
//   briefing (1.5s verb flash + bass thump)
//        ↓
//   playing (clock ticking, max `duration`)
//        ↓
//   judgment (OK stamp / scribbled-out, ~1.1s)
//        ↓
//   flip (page warps over) ──→ back to briefing
//        │
//        └─ every 10 games ──→ BOSS
//
// Escalation (GDD §3.4): every 4 games the transition speed goes up 10%, the
// music pitches up, and the linework's jitter amplifies. Escalation is applied
// HERE and nowhere else — micro-games are handed a shorter clock and a
// `heat` value, but must not scale their own difficulty (see types.ts).

import { computed, ref, shallowRef } from 'vue'
import type { MicroGame, MicroGameCtx, MicroGameStatus, Pointer } from './types'
import { recordGameResult, recordNightEnd, recordBossCleared, needsHint } from '@/use/useMidnightProgress'
import { flushSaveNow } from '@/use/useSaveStatus'
import { setMusicRate } from '@/use/useSound'

// ── Tunables ──────────────────────────────────────────────────────────────

/** GDD §3.1: "1.5 seconds". Scaled by the speed multiplier as the night heats. */
const BRIEFING_S = 1.5
/** A player's first few encounters with a game show an instruction line, and
 *  1.5s is not enough to read a full sentence AND register the verb. When a
 *  hint is on screen the briefing holds for this long instead, unscaled by
 *  speed — the whole point is giving reading time. Matches `needsHint`. */
const HINTED_BRIEFING_S = 3.4
/** How long the OK stamp / scribble-out holds before the page flips. */
const JUDGMENT_S = 1.1
/** The page-flip warp (GDD §5 "Paper Physics"). */
const FLIP_S = 0.45
/** GDD §3.4: "After every 4 games, the transition speed accelerates by 10%". */
const ESCALATE_EVERY = 4
const ESCALATE_STEP = 0.1
/** Floor on the speed multiplier — past ~2.2× the briefing is too short to
 *  read the verb, which stops being difficulty and starts being unfair. */
const MAX_SPEED = 2.2
/** Vision-board panel 7: "After completing 10 rapid micro-games, a BOSS STAGE
 *  banner slams down." */
const BOSS_EVERY = 10
/** GDD §3: three hearts. */
const MAX_HEARTS = 3

export type RunPhase =
  | 'idle'
  | 'briefing'
  | 'playing'
  | 'judgment'
  | 'flip'
  | 'bossBanner'
  | 'gameover'
  | 'morning'

export interface RunState {
  phase: RunPhase
  /** Seconds spent in the current phase. */
  phaseT: number
  /** Micro-games cleared this night — the score. */
  score: number
  /** Micro-games attempted this night (including the current one). */
  played: number
  hearts: number
  /** Speed multiplier from escalation. 1 at the start, grows 10% per 4 games. */
  speed: number
  /** The settled result of the game just played. */
  lastOutcome: 'won' | 'lost' | null
}

export const useMidnightGame = (registry: {
  micro: MicroGame[]
  boss: MicroGame
}) => {
  // ── Reactive surface (for the Vue overlay: hearts, score) ────────────────
  const phase = ref<RunPhase>('idle')
  const score = ref(0)
  const hearts = ref(MAX_HEARTS)
  const speed = ref(1)
  const lastOutcome = ref<'won' | 'lost' | null>(null)
  /** True when the night that just ended set a new personal best. Read by the
   *  summary page; set once, in `endNight`, so the celebration can't double-fire. */
  const newBest = ref(false)
  /** The game currently on the page. `shallowRef` because a MicroGame holds
   *  mutable sim state that must NOT be made reactive — deep-proxying a
   *  physics body would tank the frame budget and break identity checks. */
  const current = shallowRef<MicroGame | null>(null)

  // ── Non-reactive run state (touched every frame) ─────────────────────────
  let phaseT = 0
  let played = 0
  let gameT = 0
  let duration = 0
  /** How long the CURRENT briefing lasts — longer when its hint is showing so
   *  the player has time to read it. Set in `startGame`, read by the scene. */
  let briefingDuration = BRIEFING_S
  let bossPending = false
  let queue: MicroGame[] = []
  let seed = 1

  /** 0..1 heat, for garnish. Saturates at the speed cap. */
  const heat = computed(() => Math.min(1, (speed.value - 1) / (MAX_SPEED - 1)))

  /** The current micro-game's clock, after escalation. Never below 2.2s —
   *  under that even a perfect player can't parse the page and act. */
  const durationFor = (g: MicroGame): number =>
    g.isBoss ? g.baseDuration : Math.max(2.2, g.baseDuration / speed.value)

  // ── Bag randomiser ───────────────────────────────────────────────────────
  // A plain `random()` pick repeats the same game back-to-back often enough to
  // read as broken ("why did I get the router twice?"). Shuffling a bag of all
  // three and dealing from it guarantees variety while staying unpredictable.
  const refillQueue = (): void => {
    const bag = [...registry.micro]
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[bag[i], bag[j]] = [bag[j]!, bag[i]!]
    }
    // Avoid the seam repeat: if the bag's first is the game we just played,
    // swap it deeper in. Only matters when more than one game exists.
    if (bag.length > 1 && current.value && bag[0]!.id === current.value.id) {
      ;[bag[0], bag[1]] = [bag[1]!, bag[0]!]
    }
    queue = bag
  }

  const nextGame = (): MicroGame => {
    if (bossPending) {
      bossPending = false
      return registry.boss
    }
    if (queue.length === 0) refillQueue()
    return queue.shift()!
  }

  // ── Phase machine ────────────────────────────────────────────────────────

  const setPhase = (p: RunPhase): void => {
    phase.value = p
    phaseT = 0
  }

  const startGame = (ctx: MicroGameCtx): void => {
    const g = nextGame()
    current.value = g
    duration = durationFor(g)
    // A hinted briefing holds long enough to read the instruction and isn't
    // sped up by escalation (a first-timer shouldn't get a rushed hint); an
    // unhinted one keeps the GDD's snappy 1.5s, scaled by the heat.
    briefingDuration = needsHint(g.id) ? HINTED_BRIEFING_S : BRIEFING_S / speed.value
    gameT = 0
    seed = (Math.random() * 0xffffff) | 0
    g.init({ ...ctx, t: 0, remaining: duration, duration }, seed)
    setPhase(g.isBoss ? 'bossBanner' : 'briefing')
  }

  /** Settle the current game. Everything that must happen exactly once per
   *  result lives here — stats, hearts, escalation — so the phase machine
   *  can't double-count by re-entering. */
  const resolve = (outcome: 'won' | 'lost'): void => {
    const g = current.value
    if (!g) return
    lastOutcome.value = outcome
    played += 1
    recordGameResult(g.id, outcome === 'won')

    if (outcome === 'won') {
      score.value += 1
      if (g.isBoss) {
        recordBossCleared()
        // A boss clear is a hard checkpoint — the rarest thing a player can
        // bank. Push it to the cloud now rather than waiting out the debounce;
        // a player who clears the boss and closes the tab must keep it.
        void flushSaveNow()
      }
      // Escalate on a schedule of games PLAYED, not won — otherwise a
      // struggling player never feels the night accelerate, which is the
      // entire dramatic arc.
      if (played % ESCALATE_EVERY === 0 && speed.value < MAX_SPEED) {
        speed.value = Math.min(MAX_SPEED, speed.value + ESCALATE_STEP)
        // The lo-fi beat pitches up with the speed (GDD §3.4).
        setMusicRate(speed.value)
      }
      if (played % BOSS_EVERY === 0) bossPending = true
    } else {
      hearts.value -= 1
    }
    setPhase('judgment')
  }

  /** Advance the run. Called every sim frame by the scene. */
  const update = (ctx: MicroGameCtx, dt: number): void => {
    phaseT += dt
    const g = current.value

    switch (phase.value) {
      case 'idle':
        break

      case 'bossBanner':
        // The banner slams down and holds before the boss begins.
        if (phaseT >= 1.4) setPhase('playing')
        break

      case 'briefing':
        if (phaseT >= briefingDuration) setPhase('playing')
        break

      case 'playing': {
        if (!g) break
        gameT += dt
        const remaining = Math.max(0, duration - gameT)
        const gctx: MicroGameCtx = { ...ctx, t: gameT, remaining, duration }
        const res = g.update(gctx, dt) as MicroGameStatus | void
        if (res === 'won' || res === 'lost') {
          resolve(res)
        } else if (remaining <= 0) {
          // Timeout is always a loss — the one rule every game shares.
          resolve('lost')
        }
        break
      }

      case 'judgment':
        if (phaseT >= JUDGMENT_S / speed.value) {
          if (hearts.value <= 0) {
            endNight()
          } else if (lastOutcome.value === 'won' && g?.isBoss) {
            // Clearing the boss ends the night in triumph rather than looping
            // — the camera pulls back out to the desk (vision-board panel 8).
            endNight('morning')
          } else {
            setPhase('flip')
          }
        }
        break

      case 'flip':
        if (phaseT >= FLIP_S / speed.value) {
          g?.dispose?.()
          startGame(ctx)
        }
        break

      case 'gameover':
      case 'morning':
        break
    }
  }

  const endNight = (into: 'gameover' | 'morning' = 'gameover'): void => {
    current.value?.dispose?.()
    newBest.value = recordNightEnd(score.value)
    // Ending a night is the hard checkpoint of this game — it's the only
    // moment the record can change. Drain the save pipeline now rather than
    // waiting out the debounce; a player who closes the tab on the summary
    // screen must keep their score.
    void flushSaveNow()
    setPhase(into)
  }

  /** Begin a fresh night. */
  const start = (ctx: MicroGameCtx): void => {
    score.value = 0
    hearts.value = MAX_HEARTS
    speed.value = 1
    setMusicRate(1)
    lastOutcome.value = null
    newBest.value = false
    played = 0
    bossPending = false
    queue = []
    startGame(ctx)
  }

  const stop = (): void => {
    current.value?.dispose?.()
    current.value = null
    setPhase('idle')
    setMusicRate(1)
  }

  // ── Debug hooks (wired to the cheat shortcuts by the scene) ──────────────
  const forceOutcome = (o: 'won' | 'lost'): void => {
    if (phase.value === 'playing') resolve(o)
  }
  const queueBoss = (): void => { bossPending = true }
  const refillHearts = (): void => { hearts.value = MAX_HEARTS }

  /** Dev-only: drop straight into a named micro-game, skipping the briefing.
   *  The night is left running normally afterwards. Exposed on
   *  `window.__midnight` in dev builds so a browser session can drive a
   *  specific game deterministically instead of waiting for the bag to deal
   *  it — the phase timings make "wait and screenshot" unusable for
   *  inspecting one game. */
  const debugPlay = (ctx: MicroGameCtx, id: string): boolean => {
    const g = registry.micro.find((m) => m.id === id)
      ?? (registry.boss.id === id ? registry.boss : null)
    if (!g) return false
    current.value?.dispose?.()
    current.value = g
    duration = durationFor(g)
    gameT = 0
    hearts.value = MAX_HEARTS
    g.init({ ...ctx, t: 0, remaining: duration, duration }, (Math.random() * 0xffffff) | 0)
    setPhase('playing')
    return true
  }

  return {
    // reactive
    phase,
    score,
    hearts,
    speed,
    heat,
    lastOutcome,
    newBest,
    current,
    // control
    start,
    stop,
    update,
    // debug
    forceOutcome,
    queueBoss,
    refillHearts,
    debugPlay,
    // introspection for the overlay/HUD
    getPhaseT: () => phaseT,
    getGameT: () => gameT,
    getDuration: () => duration,
    getBriefingDuration: () => briefingDuration,
    getPlayed: () => played,
    MAX_HEARTS
  }
}

export type MidnightGame = ReturnType<typeof useMidnightGame>
