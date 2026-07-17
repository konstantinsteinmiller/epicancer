// ─── On-device DevTools toggle ──────────────────────────────────────────────
//
// vConsole is shipped in EVERY build but only mounted on demand. The
// trigger is a hidden chord on the StageBadge: 25 taps within 60 seconds.
// Once mounted, an in-page "Hide" button tears it back down.
//
// Why every build (not just `isDebug`): the user is testing the
// CrazyGames mobile app on iPhone from a Windows machine — there's no
// remote Web Inspector path. They need a way to surface logs from a
// production-mode bundle on real demand. The chord is obscure enough
// that real users will never trigger it; opt-in cost for the developer
// is one tap-spam session.
//
// Why no `isMobilePortrait` gate: that gate combined `mobileCheck()` with
// `windowWidth.value <= 500`, and the width clause was unreliable inside
// wrapper-iframes (the CrazyGames mobile app, GameDistribution iframe,
// etc.) where `window.innerWidth` reflects the iframe size, not the
// device's logical width. 25 rapid clicks on a UI badge in <60s is so
// unusual on desktop that a hard gate isn't worth the false negatives
// it caused on iPhone QA flows.

import { ref, type Ref } from 'vue'
import { isMobilePortrait } from '@/use/useUser.ts'

// vConsole's library code is ~250KB gzipped — too heavy to live in
// the main bundle for a feature only invoked on demand. Solution:
// `main.ts` (which IS in the obfuscator's exclude list) installs a
// mounter function via `setVConsoleMounter`. The mounter does a
// `await import('vconsole')` from the safe zone — Rollup splits
// vConsole into its own chunk, only fetched when the chord fires
// or the URL trigger hits.
//
// This module no longer has a direct dependency on the vConsole
// library — keeps the main chunk's hot-path size down by ~250KB.
type VConsoleMounter = () => Promise<unknown>
type VConsoleDestroyer = (instance: unknown) => void

let mounterFn: VConsoleMounter | null = null
let destroyerFn: VConsoleDestroyer | null = null

/**
 * Install the lazy-loader. Called once from `main.ts` at boot. The
 * mounter must return a promise that resolves to a vConsole instance;
 * the destroyer accepts the same instance and tears it down.
 *
 * Wiring this from `main.ts` (rather than importing vConsole directly
 * here) keeps vConsole out of the main chunk — it lives in its own
 * lazy chunk that's only fetched when a trigger fires. See the comment
 * block above for why the dynamic-import path has to be in main.ts.
 */
export const setVConsoleMounter = (
  mount: VConsoleMounter,
  destroy: VConsoleDestroyer
): void => {
  mounterFn = mount
  destroyerFn = destroy
}

/** Reactive: true when vConsole is mounted on the page. */
export const isVConsoleVisible: Ref<boolean> = ref(false)

/** Reactive: how many taps fall inside the current 60s window. The
 *  StageBadge reads this to render a tiny `tap N/25` toast so the
 *  developer can SEE whether taps are reaching the handler — which is
 *  the only useful diagnostic when vConsole itself is what they're
 *  trying to bring up. */
export const chordTapCount: Ref<number> = ref(0)

// Sliding window of recent tap timestamps (ms-since-epoch). Trimmed
// to the last 60s on each tap so memory usage is bounded.
const TAP_WINDOW_MS = 60_000
/** Number of taps that must land inside the rolling 60s window to
 *  trigger vConsole. Exported so the on-screen counter (StageBadge's
 *  `tap N/X` toast) and tests stay in lockstep with the actual gate. */
export const TAP_THRESHOLD = 20
const recentTaps: number[] = []
// Coalesce window: when one physical touch produces both pointerdown
// AND touchstart AND click within ~50ms, count it as ONE tap. Without
// this dedupe the chord would trip after 8-9 physical taps because
// each one sends 3 events.
const COALESCE_MS = 60
let lastTapAt = 0

let vConsoleInstance: unknown | null = null
let mountInFlight = false

/** Mount the vConsole UI on demand. Idempotent. Async because the
 *  vConsole library lives in a lazy chunk; the actual import happens
 *  inside the injected mounter. */
export const enableVConsole = async (): Promise<void> => {
  if (vConsoleInstance || mountInFlight) return
  if (!mounterFn) {
    console.warn('[vconsole] setVConsoleMounter has not been called — main.ts must install the loader at boot')
    return
  }
  mountInFlight = true
  try {
    vConsoleInstance = await mounterFn()
    isVConsoleVisible.value = true
  } catch (e) {
    console.warn('[vconsole] failed to mount', e)
  } finally {
    mountInFlight = false
  }
}

/** Tear down the vConsole UI and reset the chord counter. */
export const disableVConsole = (): void => {
  if (vConsoleInstance) {
    try {
      destroyerFn?.(vConsoleInstance)
    } catch (e) {
      console.warn('[vconsole] destroy threw', e)
    }
    vConsoleInstance = null
  }
  isVConsoleVisible.value = false
  recentTaps.length = 0
  chordTapCount.value = 0
}

/**
 * URL-based trigger. Honored on every boot via `bootstrapVConsoleFromUrl`
 * — exposed separately so tests can call it directly. Returns true when
 * the URL signaled vConsole should mount.
 */
export const isVConsoleSignaledByUrl = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    const search = window.location.search ?? ''
    if (/[?&]vconsole=1\b/.test(search)) return true
    const hash = window.location.hash ?? ''
    if (/(^|[#&/])vconsole(=1)?\b/.test(hash)) return true
  } catch {
    // Any URL parse oddity → safe default of "no, don't mount".
  }
  return false
}

/**
 * Auto-mount vConsole at boot when the URL contains `?vconsole=1` or
 * `#vconsole`. The most reliable trigger when the chord can't be
 * exercised on a particular device — the iPhone QA flow's URL can be
 * crafted to include this query string, no touch events needed.
 *
 * Caveat the URL-trigger doesn't always survive on CG mobile:
 * CrazyGames loads the game from a SEPARATE origin
 * (e.g. `midnight-analog.game-files.crazygames.com`) and the parent-frame
 * URL's query/hash is NOT propagated to the iframe. So `?vconsole=1`
 * appended to the CG portal URL won't reach the game's
 * `window.location`. The chord (touch-based) is the only reliable
 * trigger inside the embedded iframe.
 */
export const bootstrapVConsoleFromUrl = (): void => {
  if (isVConsoleSignaledByUrl()) {
    void enableVConsole()
  }
}

/**
 * Register a tap on the chord trigger (StageBadge). 20 taps within 60s
 * flip vConsole on.
 *
 * Returns true when this tap reached the threshold and triggered the
 * mount — useful for the caller if it wants to flash a confirmation.
 */
export const registerChordTap = (): boolean => {
  if (!isMobilePortrait.value) return false
  // Once vConsole is visible, further taps are no-ops. We check the
  // public `isVConsoleVisible` flag (rather than the private
  // `vConsoleInstance`) so tests / callers can simulate the
  // already-shown state without standing up the full vconsole module.
  if (isVConsoleVisible.value) return false

  const now = Date.now()

  // Coalesce duplicate events for the SAME physical tap. The StageBadge
  // listens on `pointerdown`, `touchstart`, AND `click` for cross-WebView
  // reliability — but a single finger-press fires all three within
  // ~30-50ms. Without this guard the chord would trip after ~8 real taps.
  if (now - lastTapAt < COALESCE_MS) return false
  lastTapAt = now

  recentTaps.push(now)

  // Drop taps older than the window — keeps the array small AND makes
  // the threshold a true rolling-window, not a lifetime counter.
  while (recentTaps.length > 0 && now - recentTaps[0]! > TAP_WINDOW_MS) {
    recentTaps.shift()
  }

  chordTapCount.value = recentTaps.length

  if (recentTaps.length >= TAP_THRESHOLD) {
    void enableVConsole()
    return true
  }
  return false
}
