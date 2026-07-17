// Reactive view of the SaveManager's hydrate state, plus a one-shot
// notice queue for the on-screen banner. Module-level singleton so any
// component can read/write without prop-drilling.
//
// Wired from main.ts after the SaveManager has been constructed. The
// banner component (`SaveStatusBanner.vue`) reads from here.

import { ref, computed } from 'vue'
import type { Ref } from 'vue'
import type { SaveManager } from '@/utils/save/SaveManager'
import type { HydrateNotice, HydrateState } from '@/utils/save/types'
import { reloadMidnightState, flushPersist } from '@/use/useMidnightState'

const hydrateState: Ref<HydrateState> = ref('pending')
const lastNotice: Ref<HydrateNotice | null> = ref(null)
const retryInFlight: Ref<boolean> = ref(false)
/**
 * Increments every time a hydrate transitions to `success-with-data`.
 * Composables that hold module-level refs initialised from localStorage
 * (`currentStageId`, `coins`, `ownedSkins`, …) watch this and re-read
 * their keys when it bumps. Without this, a successful background retry
 * after a partial-cloud-failure cold launch writes new values into
 * localStorage that the already-loaded refs never see — the player
 * stays at stage 1 / 0 coins despite the strategy having restored
 * the cloud save.
 */
const saveDataVersion: Ref<number> = ref(0)
let manager: SaveManager | null = null

/**
 * Refresh the in-memory `maw_state` blob from (now-patched) localStorage,
 * THEN bump `saveDataVersion`. Order is load-bearing: composables re-read
 * their refs via `getState(...)` inside a `watch(saveDataVersion)` callback,
 * and `getState` reads from the `mawState` ref — so the blob MUST already
 * hold the cloud-hydrated values when the watcher fires. Without the reload,
 * everything that re-reads on `saveDataVersion` (upgrades, achievements,
 * campaign stage, ghost runs, battle pass, user settings, …) would see the
 * pre-hydrate blob and silently drop the player's cloud progress. (Coins
 * happened to survive via a bespoke `watch(mawState)` in useMawConfig; this
 * makes that workaround unnecessary by fixing the root cause for every key.)
 */
const bumpSaveDataVersion = (): void => {
  reloadMidnightState()
  saveDataVersion.value++
}

/**
 * Force the whole save pipeline to flush NOW, bypassing both debounces:
 *   1. `flushPersist()` writes the in-memory `maw_state` blob to localStorage
 *      immediately (cancels the 200ms persist debounce) — which routes through
 *      the SaveManager proxy into the active strategy's dirty queue.
 *   2. `manager.flush()` drains that queue to the backend immediately
 *      (cancels the strategy's 250ms flush debounce).
 *
 * Use at hard checkpoints that MUST survive an immediate reload — chiefly a
 * level change. On the CrazyGames cloud-only build the `sdk.data` write is
 * async and only starts after the debounces elapse, so a player who clears a
 * stage and reloads a moment later lands back on the old stage. Starting the
 * push the instant the stage advances gives the cloud write the time it needs.
 * Fire-and-forget (`void`) so callers never block the UI on the network.
 */
export const flushSaveNow = async (): Promise<void> => {
  flushPersist()
  try {
    await manager?.flush()
  } catch (e) {
    console.warn('[save] flushSaveNow failed', e)
  }
}

export const installSaveStatus = (m: SaveManager): void => {
  manager = m
  hydrateState.value = m.hydrateState
  m.onHydrateNotice((notice) => {
    lastNotice.value = notice
    hydrateState.value = notice.state
    // Bump only AFTER initial boot completes. Notices arriving during
    // `init()` fire from inside the strategy's `hydrate()` — patches
    // aren't installed yet, so any composable watcher that re-reads
    // localStorage in response would hit raw storage instead of the
    // BlobStorage proxy and miss the cloud-hydrated values. Background
    // retries (offline → online recovery) are post-boot and bump
    // normally so refs refresh after a recovered cloud read.
    if (notice.state === 'success-with-data' && m.isHydrated()) {
      bumpSaveDataVersion()
    }
  })
  // Initial boot bump: fires once when SaveManager finishes patching
  // localStorage at the end of init(). After this, every composable's
  // saveDataVersion watcher sees the patched accessor and reads
  // hydrated cloud state.
  m.onBootComplete(() => {
    bumpSaveDataVersion()
  })
}

export const retrySync = async (): Promise<void> => {
  if (!manager || retryInFlight.value) return
  retryInFlight.value = true
  try {
    await manager.retryHydrate()
  } finally {
    retryInFlight.value = false
  }
}

/** True while we don't yet know the state of the cloud save — UI may
 *  want to render a small "syncing" spinner. */
export const isSyncPending = computed(() => hydrateState.value === 'pending')

/** True when remote is unreachable and the strategy is in retry mode.
 *  Drives the offline banner. */
export const isOfflineMode = computed(() =>
  hydrateState.value === 'failed-retrying' || hydrateState.value === 'failed-final'
)

export {
  hydrateState,
  lastNotice,
  retryInFlight,
  saveDataVersion
}
