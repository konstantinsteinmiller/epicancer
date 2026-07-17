// ─── Rewarded-ad throttle ─────────────────────────────────────────────────
//
// Caps rewarded video views at MAX_REWARDED inside a AD_WINDOW_MS rolling
// window per device. When throttled, `useAds` flips `isRewardedReady`
// false so the UI hides every reward button (RouletteWheel respin, 2x
// speed boost, AdRewardButton) — the same UX as a no-fill SDK state.
//
// Why per-device (localStorage), not per-account (cloud sync): this is
// an anti-abuse gate, not progress. Stored under the
// `__save_internal__` prefix so SaveManager skips forwarding it to the
// strategy — we don't want a player's watch budget travelling across
// devices.
//
// Why the periodic prune timer: `isRewardedThrottled` is a `computed`
// over a `ref` array, so it only re-evaluates when the array mutates.
// Without the pruning interval, a player who hits the cap and then
// idles for 10 minutes wouldn't see the reward button reappear until
// they triggered some other reactive write. The 60s prune cadence
// matches the resolution players actually perceive.

import { computed, ref } from 'vue'
import { getState, setState, removeState } from '@/use/useMidnightState'

const STORAGE_KEY = '__save_internal__rewarded_history'

/** Max rewarded ad views permitted inside the rolling window. */
export const MAX_REWARDED = 5
/** Width of the rolling window, in ms. */
export const AD_WINDOW_MS = 7 * 60 * 1000
/** How often to prune expired entries from the in-memory list so the
 *  reactive throttle flag flips back without requiring a fresh tap. */
const PRUNE_INTERVAL_MS = 60_000

const loadFromStorage = (): number[] => {
  const v = getState<unknown>(STORAGE_KEY)
  if (!Array.isArray(v)) return []
  return v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
}

const saveToStorage = (history: number[]): void => {
  setState(STORAGE_KEY, history)
}

const history = ref<number[]>(loadFromStorage())
// `tick` is a synthetic reactive dependency for the throttle computed.
// `isRewardedThrottled` reads `Date.now()`, which is NOT reactive — so
// without `tick`, the computed would cache its first result and never
// recompute on time advance alone. The prune timer below increments
// `tick` once per minute, giving the computed a real reactive cue to
// re-evaluate at roughly the resolution players perceive.
const tick = ref(0)

const pruneExpired = (now: number = Date.now()): void => {
  const cutoff = now - AD_WINDOW_MS
  const next = history.value.filter((t) => t > cutoff)
  if (next.length !== history.value.length) {
    history.value = next
    saveToStorage(next)
  }
  tick.value++
}

/** True when the player has watched MAX_REWARDED rewarded videos
 *  inside the trailing AD_WINDOW_MS. Composed into `useAds.isRewardedReady`
 *  so every placement (RouletteWheel, AdRewardButton, 2x speed boost)
 *  hides at once. */
export const isRewardedThrottled = computed(() => {
  // Track `tick` so the prune cadence invalidates the cache. Without
  // this, advancing wall time alone never flips the flag back to false.
  void tick.value
  const cutoff = Date.now() - AD_WINDOW_MS
  let count = 0
  for (const t of history.value) {
    if (t > cutoff) count++
  }
  return count >= MAX_REWARDED
})

/** Record one successfully-watched rewarded ad. Call only from the
 *  grant path — never on no-fill / user-skip / SDK error. */
export const recordRewardedGranted = (now: number = Date.now()): void => {
  const cutoff = now - AD_WINDOW_MS
  const pruned = history.value.filter((t) => t > cutoff)
  pruned.push(now)
  history.value = pruned
  saveToStorage(pruned)
}

/** Test hook: force a prune + tick. Production code relies on the
 *  internal interval; tests use this to flush after `setSystemTime`
 *  without having to advance fake timers a full minute. */
export const __pruneRewardedThrottleForTest = (now?: number): void => {
  pruneExpired(now)
}

/** Test-only: wipe the in-memory history and persisted blob. */
export const resetRewardedThrottle = (): void => {
  history.value = []
  tick.value++
  removeState(STORAGE_KEY)
}

// Periodic prune so the computed flips false once the oldest entry
// crosses the window boundary, even without any new tap.
if (typeof window !== 'undefined') {
  window.setInterval(() => pruneExpired(), PRUNE_INTERVAL_MS)
}
