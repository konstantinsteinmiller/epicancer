// ─── Persistent progression ────────────────────────────────────────────────
//
// Everything here is a projection of the ONE `midnight_state` blob
// (`useMidnightState.ts`). Nothing in this module owns storage: it reads the
// blob through `getState`, writes through `setState`, and re-derives itself
// whenever the blob identity changes — which is how a cloud hydrate landing
// AFTER boot (SaveManager → `reloadMidnightState()`) shows up in the UI
// without a reload. That watcher is the load-bearing part; see the comment on
// `syncFromBlob` below.

import { computed, ref, watch } from 'vue'
import { getState, setState, midnightState } from '@/use/useMidnightState'
import {
  BEST_SCORE_KEY,
  NIGHTS_SURVIVED_KEY,
  IDEAS_PLAYED_KEY,
  GAME_STATS_KEY,
  BOSSES_CLEARED_KEY,
  ONBOARDED_KEY
} from '@/keys'

export interface GameStat {
  wins: number
  plays: number
}
export type GameStats = Record<string, GameStat>

// ─── Reactive mirrors ──────────────────────────────────────────────────────

/** Best micro-games-survived count in a single night. */
export const bestScore = ref(0)
/** Lifetime completed nights. Used as the GamePix "level" signal. */
export const nightsSurvived = ref(0)
/** Lifetime micro-games played — the GamePix "games played" signal and the
 *  "3 AM ideas brought to life" number on the summary page. */
export const ideasPlayed = ref(0)
/** Lifetime boss clears. */
export const bossesCleared = ref(0)
/** Per-micro-game wins/plays. */
export const gameStats = ref<GameStats>({})
/** True once the player has cleared the desk intro at least once. */
export const isOnboarded = ref(false)

// ─── Aliases consumed by the platform layer ────────────────────────────────
// `gamepixPlugin` reports progression to the portal with these two names. They
// were the epicrolla vocabulary; Midnight Analog has no stages, so "how deep
// did they get" maps to nights survived and "how much did they play" maps to
// lifetime micro-games. Keeping the names avoids touching the SDK plumbing.
export const gamesPlayedTotal = ideasPlayed
export const maxStageReached = nightsSurvived

/** Read every field back out of the blob. Called once at module init and again
 *  on every blob-identity change so a late cloud hydrate overwrites the
 *  fresh-default zeros instead of being silently ignored. */
const syncFromBlob = (): void => {
  bestScore.value = Number(getState(BEST_SCORE_KEY, 0)) || 0
  nightsSurvived.value = Number(getState(NIGHTS_SURVIVED_KEY, 0)) || 0
  ideasPlayed.value = Number(getState(IDEAS_PLAYED_KEY, 0)) || 0
  bossesCleared.value = Number(getState(BOSSES_CLEARED_KEY, 0)) || 0
  isOnboarded.value = getState<boolean>(ONBOARDED_KEY, false) === true
  const stats = getState<GameStats>(GAME_STATS_KEY, {})
  gameStats.value = stats && typeof stats === 'object' ? stats : {}
}

syncFromBlob()

// `midnightState` is replaced wholesale (never mutated in place) by both
// `setState` and `reloadMidnightState`, so a shallow identity watch catches
// cloud hydrates. Our own `setState` calls also re-enter here, which is
// harmless — they write the same values we just set.
watch(midnightState, syncFromBlob)

// ─── Mutations ─────────────────────────────────────────────────────────────

/** Record the end of a night. `survived` is how many micro-games the player
 *  cleared; promotes it to `bestScore` when it beats the record. Returns true
 *  when a new personal best was set, so the summary page can celebrate it. */
export const recordNightEnd = (survived: number): boolean => {
  nightsSurvived.value += 1
  setState(NIGHTS_SURVIVED_KEY, nightsSurvived.value)

  if (survived > bestScore.value) {
    bestScore.value = survived
    setState(BEST_SCORE_KEY, survived)
    return true
  }
  return false
}

/** Tally one micro-game result against its lifetime stat bucket. */
export const recordGameResult = (gameId: string, won: boolean): void => {
  ideasPlayed.value += 1
  setState(IDEAS_PLAYED_KEY, ideasPlayed.value)

  const prev = gameStats.value[gameId] ?? { wins: 0, plays: 0 }
  const next: GameStat = { wins: prev.wins + (won ? 1 : 0), plays: prev.plays + 1 }
  gameStats.value = { ...gameStats.value, [gameId]: next }
  setState(GAME_STATS_KEY, gameStats.value)
}

export const recordBossCleared = (): void => {
  bossesCleared.value += 1
  setState(BOSSES_CLEARED_KEY, bossesCleared.value)
}

export const markOnboarded = (): void => {
  if (isOnboarded.value) return
  isOnboarded.value = true
  setState(ONBOARDED_KEY, true)
}

/** True for a player who has never finished a night — the desk intro holds
 *  longer for them and the first briefing gets an extra beat. */
export const isFirstNight = computed(() => nightsSurvived.value === 0)

/** How many times a player sees a micro-game's onboarding hint before it stops
 *  showing. One glance during a 1.5s briefing isn't enough to learn a control,
 *  so it repeats for the first few encounters. */
export const HINT_PLAYS = 3

/** Whether the onboarding hint (and the longer, readable briefing that goes
 *  with it) should show for `gameId`. Shared by the renderer (to draw the hint)
 *  AND the run orchestrator (to lengthen the briefing to match) so the two
 *  never disagree about whether a hint is on screen. */
export const needsHint = (gameId: string): boolean =>
  (gameStats.value[gameId]?.plays ?? 0) < HINT_PLAYS

export default () => ({
  bestScore,
  nightsSurvived,
  ideasPlayed,
  bossesCleared,
  gameStats,
  isOnboarded,
  isFirstNight,
  recordNightEnd,
  recordGameResult,
  recordBossCleared,
  markOnboarded
})
