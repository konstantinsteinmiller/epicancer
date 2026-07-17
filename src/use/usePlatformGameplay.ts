// ─── Platform gameplay-lifecycle driver ─────────────────────────────────────
//
// Portals want to know WHEN the player is actively playing vs. sitting in a
// menu / paused, so they can time interstitials and measure engagement. Both
// the CrazyGames SDK (`gameplayStart/Stop`) and the Playgama Bridge
// (`gameplay_started` / `gameplay_stopped` messages) expose this contract, and
// firing it is part of a correct integration on each.
//
// The signal is the same everywhere, so it's dispatched from ONE place here:
// gameplay is "active" when a run is in progress AND nothing is interrupting it
// (no ad, no tab-hide, no platform pause, no blocking modal). Any of those
// dropping in flips us to stopped; clearing them all flips us back to started.
//
// The active platform's start/stop functions are resolved via a single
// env-literal-gated dynamic import — the SAME pattern as `resolveSaveStrategy`
// / `resolveAdProvider`, so non-active platforms tree-shake their SDK glue out
// and never ship it. (This file is therefore on the obfuscator's exclude list
// in `vite.config.ts`; the obfuscator would mangle the dynamic-import literals.)
// The resolved functions are all idempotent and self-guard on "SDK active", so
// a spurious call is a harmless no-op.

import { watch } from 'vue'
import { isGamePaused } from '@/use/useGamePause'
import { isAnyModalOpen } from '@/use/useModalState'

interface Hooks {
  start: () => void
  stop: () => void
}

const NOOP: Hooks = { start: () => {}, stop: () => {} }

// Resolved once per session and cached. The dynamic imports are gated by
// `import.meta.env.VITE_APP_*` string literals so Rollup dead-code-eliminates
// every branch except the active build's.
let hooksPromise: Promise<Hooks> | null = null

const resolveHooks = (): Promise<Hooks> => {
  if (hooksPromise) return hooksPromise
  hooksPromise = (async (): Promise<Hooks> => {
    if (import.meta.env.VITE_APP_PLAYGAMA === 'true') {
      const m = await import('@/utils/playgamaPlugin')
      return { start: m.playgamaGameplayStart, stop: m.playgamaGameplayStop }
    }
    if (import.meta.env.VITE_APP_CRAZY_WEB === 'true') {
      const m = await import('@/use/useCrazyGames')
      return { start: m.startGameplay, stop: m.stopGameplay }
    }
    return NOOP
  })()
  return hooksPromise
}

/**
 * Wire the platform gameplay-lifecycle events for the mounted scene. Call once
 * from the scene's `setup`, passing a getter that is `true` while a run is
 * actively being played (not the title screen, not the summary screen).
 *
 * Emits `gameplayStart` on the rising edge of (playing ∧ not-interrupted) and
 * `gameplayStop` on the falling edge. Both are debounced against the last
 * dispatched state so stacked pause sources / modals never double-fire.
 */
export const usePlatformGameplay = (isPlaying: () => boolean): void => {
  let hooks: Hooks = NOOP
  let active = false

  const apply = (): void => {
    const shouldPlay = isPlaying() && !isGamePaused.value && !isAnyModalOpen.value
    if (shouldPlay === active) return
    active = shouldPlay
    try {
      if (active) hooks.start()
      else hooks.stop()
    } catch (e) {
      console.warn('[gameplay-lifecycle] dispatch threw', e)
    }
  }

  // Resolve the active platform's hooks, then reconcile once in case a run was
  // already active by the time the (async) import landed.
  void resolveHooks().then((h) => {
    hooks = h
    apply()
  })

  watch(
    [() => isPlaying(), isGamePaused, isAnyModalOpen],
    apply,
    { immediate: true }
  )
}
