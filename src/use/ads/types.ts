// Provider-agnostic ad surface. Every platform-specific ad backend
// (CrazyGames SDK, Unity LevelPlay via the Tauri mobile plugin, etc.)
// implements this interface so the four in-game ad placements
// (midgame interstitial, AdRewardButton, RouletteWheel respin, 2x
// speed-boost reward) never have to know which provider is active.
//
// Three reactive readiness gates:
//   • `isReady`           — the SDK finished init AND we're in a build
//                           where ads are expected at all. Coarse gate
//                           kept for legacy callers.
//   • `isRewardedReady`   — a rewarded video is currently loaded and
//                           the next `showRewardedAd()` will play one.
//                           Drives v-if on AdRewardButton, the roulette
//                           respin button, and the 2x speed-boost
//                           switch — anything offering a rewarded ad.
//   • `isInterstitialReady` — an interstitial is currently loaded.
//                             Used to gate the midgame battle-cadence
//                             ad so we don't pause gameplay only to
//                             fall back to "no fill".
//
// Per-format readiness flips false the moment an ad is consumed (or
// fails to load) and flips back true on the next `onAdLoaded` event
// from the native SDK. This is what guarantees buttons disappear when
// inventory runs out — exactly what we want for a kids app where
// stale "watch ad" prompts that do nothing are user-hostile.
//
// Contract notes:
//   • `showRewardedAd` resolves `true` only if the video played all the
//     way through — callers grant the reward only on `true`.
//   • `showMidgameAd` resolves when the interstitial finished or
//     errored. It never rejects: callers `await` it and resume gameplay.
//   • `init` is idempotent and safe to call when the provider is inert
//     (e.g. Noop on unsupported platforms).
import type { Ref } from 'vue'

export interface AdProvider {
  /** Human-readable name for logs / telemetry. */
  readonly name: string
  /** Reactive: true once the SDK is up and serving ads is possible. */
  readonly isReady: Ref<boolean>
  /** Reactive: true when a rewarded video is loaded and showable now. */
  readonly isRewardedReady: Ref<boolean>
  /** Reactive: true when an interstitial is loaded and showable now. */
  readonly isInterstitialReady: Ref<boolean>
  /**
   * Reactive: true when the active SDK has detected that the player's
   * browser is blocking ad requests (uBlock, AdGuard, Brave Shields,
   * Pi-hole, etc.). Used by the in-game `AdsBlockedModal` to explain why
   * the watch-ad button just refused to grant a reward.
   *
   * Each provider populates this differently:
   *   - CrazyGames    → `sdk.ad.hasAdblock()` at init + error.code on show.
   *   - GameDistribution → SDK_ERROR events with `Blocked:` messages.
   *   - LevelPlay (native) → always false; mobile SDKs aren't subject to
   *                          browser-extension blockers.
   *   - Noop           → always false.
   *
   * IMPORTANT: granting rewards when ads were blocked is against most
   * platforms' TOS (and the publisher won't pay you). The modal is the
   * honest path — explain, don't reward.
   */
  readonly isAdsBlocked: Ref<boolean>
  /**
   * Opt-in: the SDK shows its OWN ad-blocker notice, so `useAds` must NOT
   * surface the shared in-game `AdsBlockedModal` on a blocked rewarded tap —
   * doing so would stack a second popup on top of the platform's own (CG QA).
   * `isAdsBlocked` still flips (callers must not grant the reward); only the
   * redundant modal is suppressed. CrazyGames sets this; left falsy elsewhere
   * so the shared modal stays the explainer for SDKs without their own.
   */
  readonly ownsAdBlockUi?: boolean
  /**
   * Opt-in: the provider mutes the game's audio + flips the pause gate
   * ITSELF, only once the interstitial genuinely opens — by invoking the
   * `onImpression` callback passed to `showMidgameAd`. Left falsy (the
   * default) means `useAds` kills audio up front, before the SDK call.
   *
   * Why it exists: some SDKs (Yandex) report a no-fill by flashing the ad
   * container open and closing it immediately — if we'd already killed the
   * audio up front we'd have cut the win/lose result stinger for an ad the
   * player never actually saw. Deferring the mute to the real `onOpen` means
   * a no-fill leaves the sound untouched. GamePix-style SDKs that resolve
   * before the ad closes MUST keep the up-front kill, so this stays opt-in.
   */
  readonly managesMidgameAudio?: boolean
  init: () => Promise<void>
  showRewardedAd: () => Promise<boolean>
  /**
   * Show a midgame interstitial. Resolves when it finished / errored; never
   * rejects. `onImpression` is invoked the moment the ad actually opens —
   * providers that set `managesMidgameAudio` call it to mute audio at that
   * point; others ignore it (audio is already killed up front).
   */
  showMidgameAd: (onImpression?: () => void) => Promise<void>
}
