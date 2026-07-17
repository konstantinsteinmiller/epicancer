// ─── GamePix v3 SDK plugin ────────────────────────────────────────────────
//
// Lazy-loaded module that owns everything the game talks to the GamePix
// SDK about. `main.ts` only imports it when `isGamepix` is true so
// non-GamePix builds never ship the SDK glue.
//
// The v3 SDK is obfuscated; its public method names drift between minor
// releases, and several documented v2 methods exist as **stubs** on v3
// that compile cleanly but never post events. Every SDK call goes
// through `callFirstAvailable` / `callFirstAvailableSucceeded`, which
// probe a sequence of candidate names and treat "method existed and
// didn't throw" as success — critical for void methods like
// `gameLoaded()` where a naive return-value check would treat
// `undefined` as failure and double-fire on a sibling host.
//
// **Top-level FIRST, `.game` nested second.** `sdk.gameLoaded` and
// `sdk.game.gameLoaded` both exist on the live v3 object, but only the
// top-level form actually posts `GAME_LOADED`. The nested form is a
// v2-compat stub. Same rule for `gameLoading`, `customLoading`,
// `updateScore`, `updateLevel`, `happyMoment`, ad methods, etc.
//
// **Canonical ad method names FIRST.** The testing toolkit's debug
// panel watches for the canonical v2 names (`rewardAd`,
// `interstitialAd`) and shows red until ONE of those exact names is
// invoked. Probe canonical first, then v3-prefixed aliases.
//
// Pause routing: `pauseGame()` / `resumeGame()` from
// `@/use/useGamePause` flip `isPlatformPaused`, which OR's into
// `isGamePaused`. The shared `useGamePauseAudio` orchestrator watches
// that aggregate gate and suspends/resumes audio for every build — this
// plugin only flips the flag, it never touches audio directly.

import { ref, watch } from 'vue'
import { isGamepix } from '@/use/useUser'
import { isDebug } from '@/use/useMatch'
import { isPlatformPaused, isVisibilityHidden, pauseGame, resumeGame } from '@/use/useGamePause'
import { setPlatformAudioMuted } from '@/use/useGamePauseAudio'
import { gamesPlayedTotal, maxStageReached } from '@/use/useMidnightProgress'

declare global {
  interface Window {
    GamePix?: any
    __saveManager?: { flush?: () => Promise<void> }
  }
}

const SDK_SRC = 'https://integration.gamepix.com/sdk/v3/gamepix.sdk.js'
const SDK_READY_TIMEOUT_MS = 10_000
const SCORE_DEBOUNCE_MS = 1500

/** Debug-gated console.info. The integration's per-boot / per-ad audit logs
 *  (callback registration, pause/resume relay, ad dispatch, portal-storage
 *  round-trip) are useful when diagnosing but spam the QA console on every
 *  reload. Route them through here so they only appear when `isDebug` is on —
 *  flip it with the `cmarc` cheat or `localStorage.setItem('debug','true')`.
 *  Genuine error `console.warn`s (init threw, SDK never appeared, …) stay
 *  unconditional. */
const dlog = (...args: unknown[]): void => {
  if (isDebug.value) console.info(...args)
}

// ─── Reactive surface ──────────────────────────────────────────────────────

/** True once `window.GamePix` was found AND `init()` resolved. */
export const isGamepixSdkActive = ref(false)
/** Alias preferred by the registry barrel — same source of truth. */
export const isGamePixSdkActive = isGamepixSdkActive

/** True when the SDK script failed to load (ad-blocker most likely),
 *  or when an ad call surfaced a blocker hint. Drives
 *  `AdProvider.isAdsBlocked` via `GamepixProvider`. */
export const isGamepixAdsBlocked = ref(false)
export const isGamePixAdsBlocked = isGamepixAdsBlocked

/** True once the parent portal posted `GAME_LOADED_EXECUTED` back to
 *  the iframe (the SDK's internal K flag flipped). Informational only —
 *  do NOT gate calls on this; empirically the callback never fires on
 *  either the testing toolkit OR the live portal. */
export const isGamePixPlayerReady = ref(false)

/** Two-letter locale derived from `GamePix.lang()` / `getLocale()` /
 *  `getLanguage()`. `null` until probed. */
export const gamePixLocale = ref<string | null>(null)

// ─── Internal handles ──────────────────────────────────────────────────────

let sdk: any = null
let initPromise: Promise<void> | null = null
let injectPromise: Promise<any> | null = null
let gameLoadedFired = false
let visibilityBridgeInstalled = false
let scoreWatchersInstalled = false

// ─── Interstitial close-signal plumbing ─────────────────────────────────────
//
// The unified pause gate (`isAdShowing`) is held by `useAds.showMidgameAd`
// only for as long as `interstitialAd()`'s promise is pending. On some portal
// builds that promise resolves at ad-START (or near-instantly), which would
// drop the gate while the ad is still on screen and let music/SFX play
// underneath it — the GamePix QA finding. When the SDK DOES bracket the ad
// with its pause/resume callbacks, `showMidgameAdGP` holds the gate open until
// the resume actually fires, bounded by a hard cap so a missing resume can
// never strand the game muted.
const INTERSTITIAL_MAX_HOLD_MS = 30_000
/** Set true by `onPlatformPause` while an interstitial is in flight; reset at
 *  the start of each interstitial. Lets the wrapper distinguish "the SDK is
 *  bracketing this ad with pause/resume" from "no callbacks at all". */
let interstitialPauseObserved = false
let resumeResolvers: Array<() => void> = []
const signalPlatformResume = (): void => {
  if (resumeResolvers.length === 0) return
  const pending = resumeResolvers
  resumeResolvers = []
  for (const r of pending) r()
}
/** Resolve on the next `onPlatformResume`, or after `maxMs` — whichever comes
 *  first. The timeout is the safety valve against an SDK that fires pause but
 *  never the matching resume. */
const waitForPlatformResume = (maxMs: number): Promise<void> =>
  new Promise((resolve) => {
    let done = false
    const finish = (): void => { if (!done) { done = true; resolve() } }
    resumeResolvers.push(finish)
    setTimeout(finish, maxMs)
  })

// ─── Defensive call helpers ────────────────────────────────────────────────

const callFirstAvailable = <T = unknown>(
  host: any,
  names: ReadonlyArray<string>,
  ...args: any[]
): T | undefined => {
  if (!host) return undefined
  for (const name of names) {
    const fn = host[name]
    if (typeof fn === 'function') {
      try { return fn.apply(host, args) as T }
      catch (e) { if (isDebug.value) console.warn(`[gamepix] ${name} threw`, e) }
    }
  }
  return undefined
}

const callFirstAvailableSucceeded = (
  host: any,
  names: ReadonlyArray<string>,
  ...args: any[]
): { ok: boolean; name?: string } => {
  if (!host) return { ok: false }
  for (const name of names) {
    const fn = host[name]
    if (typeof fn === 'function') {
      try { fn.apply(host, args); return { ok: true, name } }
      catch (e) { if (isDebug.value) console.warn(`[gamepix] ${name} threw`, e) }
    }
  }
  return { ok: false }
}

// ─── SDK script injection (build-time tag is primary, this is fallback) ───

const ensureSdkLoaded = (): Promise<any> => {
  if (injectPromise) return injectPromise
  injectPromise = new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      resolve(null); return
    }
    if (window.GamePix) { resolve(window.GamePix); return }

    let settled = false
    const finish = (value: any, reason: string): void => {
      if (settled) return
      settled = true
      if (isDebug.value) console.info(`[gamepix] ensureSdkLoaded resolved via ${reason}`)
      resolve(value)
    }

    const existing = document.querySelector(`script[src="${SDK_SRC}"]`) as HTMLScriptElement | null
    const armPolling = (label: string) => {
      // Poll for ~1s in case the script set `window.GamePix` after the
      // `load` event (some SDK builds defer the global assignment).
      const start = performance.now()
      const tick = () => {
        if (window.GamePix) { finish(window.GamePix, `${label} polling`); return }
        if (performance.now() - start > 1000) { finish(null, `${label} polling timeout`); return }
        setTimeout(tick, 32)
      }
      tick()
    }

    if (existing) {
      if (window.GamePix) { finish(window.GamePix, 'existing tag — already loaded'); return }
      existing.addEventListener('load', () => armPolling('existing tag load'), { once: true })
      existing.addEventListener('error', () => {
        isGamepixAdsBlocked.value = true
        finish(null, 'existing tag error')
      }, { once: true })
      setTimeout(() => finish(null, 'existing tag global timeout'), SDK_READY_TIMEOUT_MS)
      return
    }

    const script = document.createElement('script')
    script.src = SDK_SRC
    script.async = true
    script.addEventListener('load', () => armPolling('injected tag load'), { once: true })
    script.addEventListener('error', () => {
      isGamepixAdsBlocked.value = true
      console.warn(`[gamepix] SDK script failed to load (${SDK_SRC}) — likely ad-blocker`)
      finish(null, 'injected tag error')
    }, { once: true })
    setTimeout(() => finish(null, 'global init timeout'), SDK_READY_TIMEOUT_MS)
    document.head.appendChild(script)
  })
  return injectPromise
}

// ─── Lifecycle hook registration ───────────────────────────────────────────

const onPlatformPause = (): void => {
  if (isDebug.value) console.info('[gamepix] platform PAUSE callback fired')
  // Remember a pause was seen for the in-flight interstitial so the ad
  // wrapper knows to hold the gate until the matching resume (see
  // `showMidgameAdGP`). Cleared at the start of each interstitial.
  interstitialPauseObserved = true
  pauseGame()
}
const onPlatformResume = (): void => {
  if (isDebug.value) console.info('[gamepix] platform RESUME callback fired')
  resumeGame()
  // Release any interstitial wrapper that is holding the gate open waiting
  // for the ad to close.
  signalPlatformResume()
}
// soundOff / soundOn are the portal's "mute the game now" signal (its own
// sound toggle, or an ad layer that wants silence). They are audio-only —
// they do NOT pause gameplay — so they route through the orchestrator's
// dedicated audio-mute slot, not the pause gate. Previously these were dead
// no-op stubs, so a portal that muted via the sound callbacks (instead of, or
// in addition to, pause/resume) left the game's music audible — exactly the
// GamePix QA finding.
const onPlatformSoundOff = (): void => {
  dlog('[gamepix] platform soundOff callback fired → muting audio')
  setPlatformAudioMuted(true)
}
const onPlatformSoundOn = (): void => {
  dlog('[gamepix] platform soundOn callback fired → unmuting audio')
  setPlatformAudioMuted(false)
}

const registerLifecycleHooks = (): void => {
  if (!sdk) return

  // The SDK source de-obfuscates to:
  //   `... === e ? window[GAMEPIX_GLOBAL][e]() : window[GAMEPIX_GLOBAL][ON_OBJ][e]()`
  // — it tries the top-level slot first, falls back to `.on[name]`.
  // Install at BOTH; different builds dispatch through different paths.
  try {
    sdk.pause = onPlatformPause
    sdk.resume = onPlatformResume
    sdk.soundOn = onPlatformSoundOn
    sdk.soundOff = onPlatformSoundOff
  } catch (e) {
    console.warn('[gamepix] top-level callback registration failed', e)
  }

  try {
    if (!sdk.on || typeof sdk.on !== 'object') sdk.on = {}
    sdk.on.pause = onPlatformPause
    sdk.on.resume = onPlatformResume
    sdk.on.soundOn = onPlatformSoundOn
    sdk.on.soundOff = onPlatformSoundOff
  } catch (e) {
    console.warn('[gamepix] sdk.on callback registration failed', e)
  }

  // Defensive: SDK shims that wire dispatch through an
  // `addEventListener` / `subscribe` surface. Try both lowercase and
  // uppercase event names — observed in the wild.
  const tryListener = (event: string, handler: () => void): void => {
    callFirstAvailable(sdk, ['addEventListener', 'subscribe'], event, handler)
  }
  tryListener('pause', onPlatformPause)
  tryListener('resume', onPlatformResume)
  tryListener('PAUSE', onPlatformPause)
  tryListener('RESUME', onPlatformResume)
  tryListener('soundOn', onPlatformSoundOn)
  tryListener('soundOff', onPlatformSoundOff)
}

// ─── Visibility bridge (the SDK does NOT install its own listener) ───────

const invokeSdkPause = (): void => {
  if (!sdk) return
  try { if (typeof sdk.pause === 'function') sdk.pause() } catch (e) { if (isDebug.value) console.warn('[gamepix] sdk.pause threw', e) }
  try { if (typeof sdk.on?.pause === 'function') sdk.on.pause() } catch (e) { if (isDebug.value) console.warn('[gamepix] sdk.on.pause threw', e) }
  try {
    if (sdk.game && typeof sdk.game.ping === 'function') sdk.game.ping('pause', {})
  } catch (e) { if (isDebug.value) console.warn('[gamepix] sdk.game.ping(pause) threw', e) }
}

const invokeSdkResume = (): void => {
  if (!sdk) return
  try { if (typeof sdk.resume === 'function') sdk.resume() } catch (e) { if (isDebug.value) console.warn('[gamepix] sdk.resume threw', e) }
  try { if (typeof sdk.on?.resume === 'function') sdk.on.resume() } catch (e) { if (isDebug.value) console.warn('[gamepix] sdk.on.resume threw', e) }
  try {
    if (sdk.game && typeof sdk.game.ping === 'function') sdk.game.ping('resume', {})
  } catch (e) { if (isDebug.value) console.warn('[gamepix] sdk.game.ping(resume) threw', e) }
}

const installVisibilityBridge = (): void => {
  if (visibilityBridgeInstalled) return
  visibilityBridgeInstalled = true
  watch(isVisibilityHidden, (hidden) => {
    const event = hidden ? 'PAUSE' : 'RESUME'
    if (hidden) invokeSdkPause()
    else invokeSdkResume()
    try {
      window.parent?.postMessage({ type: event }, '*')
      window.parent?.postMessage({ type: event, source: 'gamepix-sdk' }, '*')
    } catch {
      // Cross-origin parent / iframe sandboxing can throw — non-fatal.
    }
  })
}

// ─── Loading-event protocol ───────────────────────────────────────────────
//
// The toolkit's `checkGamePauseResume` walks the loading-event history
// when validating the pause/resume bridge. Without a complete chain it
// dies with `processLoadingEvent is not a function` on every pause-test
// click.

const onPlayerReady = (): void => {
  if (isGamePixPlayerReady.value) return
  isGamePixPlayerReady.value = true
  dlog('[gamepix] player ready (GAME_LOADED_EXECUTED received)')
}

const gamepixCustomLoading = (active: boolean): void => {
  if (!sdk || !isGamepixSdkActive.value) return
  const top = callFirstAvailableSucceeded(sdk, ['customLoading', 'setCustomLoading'], active)
  if (top.ok) return
  if (sdk.game) callFirstAvailableSucceeded(sdk.game, ['customLoading', 'setCustomLoading'], active)
}

const gamepixGameLoading = (percent: number): void => {
  if (!sdk || !isGamepixSdkActive.value) return
  // After `gameLoaded` fires once, every subsequent `gameLoading` call
  // errors `LOADING_CALLED_AFTER_LOADED`. Guard with the module flag.
  if (gameLoadedFired) return
  const safe = Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0
  const top = callFirstAvailableSucceeded(sdk, ['gameLoading', 'loading'], safe)
  if (top.ok) return
  if (sdk.game) callFirstAvailableSucceeded(sdk.game, ['gameLoading', 'loading'], safe)
}

const gamepixGameLoaded = (): void => {
  if (!sdk || !isGamepixSdkActive.value) return
  if (gameLoadedFired) return
  const cb = (): void => onPlayerReady()
  const top = callFirstAvailableSucceeded(sdk, ['gameLoaded', 'loaded'], cb)
  if (top.ok) { gameLoadedFired = true; return }
  if (sdk.game) {
    const nested = callFirstAvailableSucceeded(sdk.game, ['gameLoaded', 'loaded'], cb)
    if (nested.ok) gameLoadedFired = true
  }
}

/** Fire the complete loading-event chain in one synchronous block —
 *  `customLoading(true) → gameLoading(0..100) → gameLoaded(cb) →
 *  customLoading(false)`. The toolkit's `checkGamePauseResume`
 *  validator walks the event history every time the player clicks
 *  Pause / Resume in the dev panel; a partial chain dies with
 *  `processLoadingEvent is not a function` and the pause/resume
 *  callbacks never fire even though they're registered.
 *
 *  Called from `gamepixPlugin()` synchronously right after
 *  `registerLifecycleHooks()`. The `gameLoadedFired` guard inside
 *  each fire-helper prevents subsequent shim calls from re-firing.
 *
 *  The semantic loss is small: the SDK doesn't gate ads or anything
 *  else on "real" load progress — it just needs a complete chain.
 *  And the `gameLoaded` callback is informational only (the K flag
 *  may flip later when the parent posts `GAME_LOADED_EXECUTED`
 *  back). */
const runFullLoadingBracket = (): void => {
  gamepixCustomLoading(true)
  gamepixGameLoading(0)
  gamepixGameLoading(50)
  gamepixGameLoading(100)
  gamepixGameLoaded()
  gamepixCustomLoading(false)
}

/** Shim for `main.ts` — kept for API symmetry with `playgamaLoadingStart`,
 *  but a no-op when the full bracket already ran inside `gamepixPlugin()`.
 *  Re-fires would be guarded by `gameLoadedFired` anyway. */
export const gamePixGameLoadingStart = (): void => {
  if (!isGamepixSdkActive.value) return
  if (gameLoadedFired) return
  runFullLoadingBracket()
}

/** Shim for `FLogoProgress.vue` — same no-op semantics. The full
 *  bracket already fired at boot so the `gameLoaded` edge has been
 *  posted by the time the splash dismisses; this exists so the same
 *  splash-resolved-edge wiring that drives CG `stopLoading` and
 *  Playgama `game_ready` stays uniform. */
export const gamePixGameLoadingStop = (): void => {
  if (!isGamepixSdkActive.value) return
  if (gameLoadedFired) return
  runFullLoadingBracket()
}

// ─── Score / level reporting ──────────────────────────────────────────────

const coerceFiniteInt = (n: number): number =>
  Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0

export const gamePixUpdateScore = (score: number): void => {
  if (!sdk || !isGamepixSdkActive.value) return
  const safe = coerceFiniteInt(score)
  const top = callFirstAvailableSucceeded(sdk, ['updateScore', 'setScore'], safe)
  if (top.ok) return
  if (sdk.game) callFirstAvailableSucceeded(sdk.game, ['updateScore', 'setScore'], safe)
}

export const gamePixUpdateLevel = (level: number): void => {
  if (!sdk || !isGamepixSdkActive.value) return
  const safe = coerceFiniteInt(level)
  const top = callFirstAvailableSucceeded(sdk, ['updateLevel', 'setLevel'], safe)
  if (top.ok) return
  if (sdk.game) callFirstAvailableSucceeded(sdk.game, ['updateLevel', 'setLevel'], safe)
}

const installScoreLevelWatchers = (): void => {
  if (scoreWatchersInstalled) return
  scoreWatchersInstalled = true

  // Boot value flushed immediately so the toolkit's debug panel lights
  // up at boot even before the first in-game change.
  let pendingScore = gamesPlayedTotal.value
  let scoreTimer: ReturnType<typeof setTimeout> | null = null
  const flushScore = (): void => {
    scoreTimer = null
    gamePixUpdateScore(pendingScore)
  }
  gamePixUpdateScore(pendingScore)

  // Trailing-edge debounce: some game state changes many times per
  // second (cascading drops, frame-rate-coupled counters). Spamming
  // `updateScore` wastes the SDK's input-validation budget and the
  // toolkit panel flickers. 1500 ms is the sweet spot.
  watch(gamesPlayedTotal, (next) => {
    pendingScore = next
    if (scoreTimer === null) scoreTimer = setTimeout(flushScore, SCORE_DEBOUNCE_MS)
  })

  watch(maxStageReached, (stage) => gamePixUpdateLevel(stage), { immediate: true })
}

// ─── Ad show wrappers ─────────────────────────────────────────────────────
//
// Canonical v2 names FIRST so the toolkit's debug indicators light up
// (it watches for `rewardAd` / `interstitialAd` specifically and stays
// red on the v3-prefixed aliases).

const REWARD_METHODS = ['rewardAd', 'showRewardAd', 'requestRewardAd'] as const
const INTERSTITIAL_METHODS = ['interstitialAd', 'showInterstitialAd', 'requestInterstitialAd'] as const

const looksLikeBlockerResult = (value: any): boolean => {
  const code = String(value?.error?.code ?? value?.code ?? '').toLowerCase()
  if (code.includes('block')) return true
  const msg = String(value?.error?.message ?? value?.message ?? '').toLowerCase()
  return msg.includes('block')
}

interface ResolvedAdMethod {
  path: string
  fn: (...args: any[]) => any
  /** `this` value to bind when invoking — `sdk` for top-level methods,
   *  `sdk.ad` for namespaced ones. v3 SDK does `this` checks internally
   *  on some method paths, so a wrong bind silently no-ops. */
  thisArg: any
}

const resolveAdMethod = (candidates: ReadonlyArray<string>): ResolvedAdMethod | null => {
  if (!sdk) return null
  // Top-level first — `sdk.rewardAd` / `sdk.interstitialAd` is what the
  // toolkit's debug indicators watch for and what the obfuscated v3
  // surface dispatches through.
  for (const name of candidates) {
    const fn = sdk[name]
    if (typeof fn === 'function') return { path: name, fn, thisArg: sdk }
  }
  // `sdk.ad.requestAd('rewarded' | 'midgame')` — CrazyGames-style
  // namespaced surface. Some v3 SDK builds expose it as a fallback.
  if (sdk.ad && typeof sdk.ad.requestAd === 'function') {
    return { path: 'ad.requestAd', fn: sdk.ad.requestAd, thisArg: sdk.ad }
  }
  // `sdk.game.X` — v2-compat stubs. Last resort.
  if (sdk.game) {
    for (const name of candidates) {
      const fn = sdk.game[name]
      if (typeof fn === 'function') return { path: `game.${name}`, fn, thisArg: sdk.game }
    }
  }
  return null
}

const callAd = async (kind: 'reward' | 'interstitial'): Promise<boolean> => {
  if (!sdk || !isGamepixSdkActive.value) return false
  const candidates = kind === 'reward' ? REWARD_METHODS : INTERSTITIAL_METHODS
  const resolved = resolveAdMethod(candidates)
  if (!resolved) {
    console.warn(`[gamepix] no ${kind} ad method found on SDK; available top-level keys:`, sdk && Object.keys(sdk))
    return false
  }
  // Unconditional (not debug-gated) — these are the per-ad audit logs that make
  // a portal QA pass debuggable without flipping a cheat flag, matching the
  // approved nexusorbiter integration. They fire only on an actual ad request.
  console.info(`[gamepix] dispatching ${kind} ad via sdk.${resolved.path}`)
  try {
    // `sdk.ad.requestAd` is the namespaced fallback — takes a kind arg
    // (`'rewarded'` / `'midgame'`); the canonical `rewardAd` /
    // `interstitialAd` methods take no positional kind.
    const raw = resolved.path === 'ad.requestAd'
      ? resolved.fn.call(resolved.thisArg, kind === 'reward' ? 'rewarded' : 'midgame')
      : resolved.fn.call(resolved.thisArg)
    // Log whether the SDK returned a Promise or a synchronous value —
    // some v3 builds dispatch fire-and-forget (return undefined) and we
    // must NOT await undefined or we'd misread it as `{success:false}`.
    const isPromise = raw && typeof (raw as any).then === 'function'
    console.info(`[gamepix] ${resolved.path} returned ${isPromise ? 'Promise' : typeof raw}`, raw)
    const result = isPromise ? await raw : raw
    // Print the result inline so we don't have to expand a collapsed
    // `Object` in the QA console. JSON.stringify guards against
    // circular structure (rare for SDK return shapes, but defensive).
    let resultJson: string
    try {
      resultJson = JSON.stringify(result)
    } catch {
      resultJson = '[unserialisable]'
    }
    const successFlag = result && typeof result === 'object' ? (result as any).success : undefined
    console.info(
      `[gamepix] ${kind} ad call resolved: success=${successFlag} keys=[${Object.keys(result || {}).join(',')}] json=${resultJson}`
    )
    if (looksLikeBlockerResult(result)) isGamepixAdsBlocked.value = true
    return Boolean(result && result.success === true)
  } catch (e) {
    console.warn(`[gamepix] ${resolved.path} threw`, e)
    return false
  }
}

export const showRewardedAdGP = (): Promise<boolean> => callAd('reward')

export const showMidgameAdGP = async (): Promise<boolean> => {
  // Reset the per-ad pause marker so we only react to a pause from THIS ad.
  interstitialPauseObserved = false
  const success = await callAd('interstitial')
  // Safety net: if the SDK acknowledged an ad AND bracketed it with a pause
  // that hasn't been cleared by a resume yet, keep the unified pause gate held
  // (this call hasn't resolved, so `useAds` keeps `isAdShowing` true) until the
  // resume fires or the hard cap elapses. Without this, an `interstitialAd()`
  // that resolves before the ad visually closes would let audio resume under
  // the ad. No-fill / no-callback paths fall straight through so we never
  // over-mute a build that resolves at true ad-close.
  if (success && interstitialPauseObserved && isPlatformPaused.value) {
    if (isDebug.value) console.info('[gamepix] interstitial: holding gate until resume')
    await waitForPlatformResume(INTERSTITIAL_MAX_HOLD_MS)
    if (isDebug.value) console.info('[gamepix] interstitial: gate released (resume or cap)')
  }
  return success
}

// ─── Happy-moment trigger ─────────────────────────────────────────────────

export const gamePixHappyMoment = (): void => {
  if (!sdk || !isGamepixSdkActive.value) return
  if (callFirstAvailableSucceeded(sdk, ['happyMoment', 'happytime']).ok) return
  if (sdk.game) callFirstAvailableSucceeded(sdk.game, ['happyMoment', 'happytime'])
}

// ─── Locale capture ───────────────────────────────────────────────────────

const captureLocale = (): void => {
  if (!sdk) return
  const raw = callFirstAvailable<string>(sdk, ['lang', 'getLocale', 'getLanguage'])
  if (typeof raw !== 'string' || raw.length < 2) return
  const code = raw.split(/[-_]/)[0]!.toLowerCase()
  gamePixLocale.value = code
  if (isDebug.value) console.info(`[gamepix] locale captured: ${code}`)
}

// ─── Portal-storage probe (canary) ────────────────────────────────────────

const probePortalStorage = (): void => {
  if (!sdk) return
  const ls = sdk.localStorage
  if (!ls) {
    console.warn('[gamepix] sdk.localStorage NOT exposed — settings will only persist via native localStorage on this build')
    return
  }
  if (isDebug.value) {
    console.info('[gamepix] sdk.localStorage online', {
      getItem: typeof ls.getItem,
      setItem: typeof ls.setItem,
      removeItem: typeof ls.removeItem
    })
  }
  const probeKey = '__gp_storage_probe__'
  const probeValue = 'ok'
  try {
    ls.setItem(probeKey, probeValue)
    const readback = ls.getItem(probeKey)
    if (readback === probeValue) {
      dlog('[gamepix] portal-storage round-trip OK — writes will persist')
      try { ls.removeItem(probeKey) } catch { /* noop */ }
    } else if (isDebug.value) {
      // Expected on localhost / no-player toolkit; only surface under debug.
      console.warn('[gamepix] portal-storage round-trip FAILED — writes will fall back to native localStorage')
    }
  } catch (e) {
    if (isDebug.value) console.warn('[gamepix] portal-storage round-trip THREW', e)
  }
}

// ─── SaveManager flush trigger ────────────────────────────────────────────

/** Drain `GamePixStrategy`'s queued writes the moment
 *  `sdk.localStorage` becomes reachable, instead of waiting for the
 *  250 ms flush poll inside the strategy. The SaveManager handle is
 *  installed by `main.ts` immediately after construction. */
const flushSaveManager = (): void => {
  const sm = (window as unknown as { __saveManager?: { flush?: () => Promise<void> } }).__saveManager
  if (!sm || typeof sm.flush !== 'function') return
  void sm.flush().catch((e) => console.warn('[gamepix] save flush failed', e))
}

// ─── Public init ──────────────────────────────────────────────────────────

export const gamepixPlugin = (): Promise<void> => {
  if (initPromise) return initPromise
  if (!isGamepix) {
    initPromise = Promise.resolve()
    return initPromise
  }
  initPromise = (async () => {
    const candidate = await ensureSdkLoaded()
    if (!candidate) {
      console.warn('[gamepix] window.GamePix never appeared — staying inert')
      return
    }
    sdk = candidate

    try {
      if (typeof sdk.init === 'function') await sdk.init()
    } catch (e) {
      console.warn('[gamepix] SDK init threw', e)
    }

    isGamepixSdkActive.value = true
    registerLifecycleHooks()
    installParentMessageListener()
    installVisibilityBridge()
    probePortalStorage()
    flushSaveManager()
    captureLocale()
    // Fire the complete loading-event chain HERE, synchronously inside
    // the plugin boot — NOT split across main.ts + FLogoProgress.
    // The toolkit's `checkGamePauseResume` validator walks the
    // loading-event history every time the player clicks Pause /
    // Resume in its dev panel; a partial chain dies with
    // `processLoadingEvent is not a function` and the pause/resume
    // callbacks never fire even though they're registered. The SDK's
    // K (Player-ready) flag also only flips after the parent posts
    // `GAME_LOADED_EXECUTED` back — which it only does once our
    // `gameLoaded` event has been posted. Until K flips, every ad
    // call is silently queued internally and `rewardAd` /
    // `interstitialAd` toolkit indicators stay red.
    runFullLoadingBracket()
    installScoreLevelWatchers()
    // Verify the callbacks actually stuck — some SDK builds wire
    // `pause` / `resume` slots with defineProperty getters that
    // silently reject assignment. Re-register if the readback shows
    // our function didn't take.
    verifyLifecycleHooks()
  })()
  return initPromise
}

/** Read back the callback slots after `gameLoaded` to catch the case
 *  where the SDK's gameLoaded path overwrote our registrations with
 *  its own internal handlers. Re-asserts if the slot is no longer
 *  our `onPlatformPause` function. Audit log uses inline values
 *  (not a collapsed object) so the QA console shows the typeof
 *  string without an expand-click. */
const verifyLifecycleHooks = (): void => {
  if (!sdk) return
  try {
    if (sdk.pause !== onPlatformPause) {
      dlog('[gamepix] sdk.pause was overwritten by SDK init — re-asserting')
      sdk.pause = onPlatformPause
      sdk.resume = onPlatformResume
      sdk.soundOn = onPlatformSoundOn
      sdk.soundOff = onPlatformSoundOff
    }
    if (sdk.on && sdk.on.pause !== onPlatformPause) {
      sdk.on.pause = onPlatformPause
      sdk.on.resume = onPlatformResume
      sdk.on.soundOn = onPlatformSoundOn
      sdk.on.soundOff = onPlatformSoundOff
    }
    const sdkPauseOk = sdk.pause === onPlatformPause
    const sdkResumeOk = sdk.resume === onPlatformResume
    const sdkOnPauseOk = sdk.on?.pause === onPlatformPause
    const sdkOnResumeOk = sdk.on?.resume === onPlatformResume
    dlog(
      `[gamepix] callbacks: sdk.pause=${typeof sdk.pause}(${sdkPauseOk ? 'ours' : 'overwritten'})`
      + ` sdk.resume=${typeof sdk.resume}(${sdkResumeOk ? 'ours' : 'overwritten'})`
      + ` sdk.on.pause=${typeof sdk.on?.pause}(${sdkOnPauseOk ? 'ours' : 'overwritten'})`
      + ` sdk.on.resume=${typeof sdk.on?.resume}(${sdkOnResumeOk ? 'ours' : 'overwritten'})`
    )
  } catch (e) {
    console.warn('[gamepix] verifyLifecycleHooks threw', e)
  }
}

// ─── Parent-message backup listener ───────────────────────────────────────
//
// The toolkit's Pause / Resume buttons post messages to our iframe; the
// SDK's job is to receive them and invoke `sdk.pause` / `sdk.resume`.
// Empirically that relay doesn't happen on every SDK build — either the
// SDK's message listener never installed (init aborted on a 403 auth
// fetch?), or it's filtering out events from the toolkit's iframe
// origin. Subscribe directly to `window.message` as a parallel path so
// QA pause / resume drives our `pauseGame()` / `resumeGame()` even when
// the SDK relay is dead.
//
// We also LOG every message we see (gated on `isDebug` so it doesn't
// spam production), so we can see exactly what envelopes the parent is
// sending and debug the relay if it stays broken.

// ─── Pause → audio-suspend ─────────────────────────────────────────────────
//
// The audio mute is NOT wired here anymore. GamePix's portal Pause button
// and visibility changes flip `isPlatformPaused` / `isVisibilityHidden`
// (via `pauseGame`/`resumeGame` and `useGamePause`'s own listener); the
// shared `useGamePauseAudio` orchestrator watches the aggregate
// `isGamePaused` and suspends/resumes audio for every build in one place.
// Keeping a second suspend driver here would double-count the ref-counted
// suspend stack — moved out on purpose.

let parentMessageListenerInstalled = false
const installParentMessageListener = (): void => {
  if (parentMessageListenerInstalled) return
  if (typeof window === 'undefined') return
  parentMessageListenerInstalled = true
  window.addEventListener('message', (ev: MessageEvent) => {
    // Read the type field defensively — the toolkit's actual envelope
    // shape is undocumented and varies between QA tool / live portal.
    const data = ev.data
    const typeRaw =
      typeof data === 'string' ? data
      : typeof data?.type === 'string' ? data.type
      : typeof data?.event === 'string' ? data.event
      : typeof data?.action === 'string' ? data.action
      : typeof data?.name === 'string' ? data.name
      : ''
    if (!typeRaw) return
    const type = typeRaw.toUpperCase()

    if (isDebug.value) {
      console.info(`[gamepix] parent message: type=${typeRaw} data=`, data)
    }

    if (type === 'PAUSE' || type === 'PAUSE_GAME' || type === 'GAME_PAUSE') {
      dlog('[gamepix] PAUSE received from parent — pausing game')
      pauseGame()
      return
    }
    if (type === 'RESUME' || type === 'RESUME_GAME' || type === 'GAME_RESUME') {
      dlog('[gamepix] RESUME received from parent — resuming game')
      resumeGame()
      return
    }
  })
}

/** Backwards-compat alias for older callers (the previous integration
 *  used `initGamepix`). Same idempotent init promise. */
export const initGamepix = gamepixPlugin

// ─── Backwards-compat re-exports (older callers used these names) ─────────

export const showRewardedGP = showRewardedAdGP
export const showInterstitialGP = showMidgameAdGP
export { gamepixCustomLoading, gamepixGameLoading, gamepixGameLoaded }
