// GameMonetize.com ad provider — wraps the `gameMonetizePlugin` in the
// cross-platform `AdProvider` surface consumed by `useAds`.
//
// Imports are STATIC (matching the GamePix / nexusorbiter pattern). The previous
// DYNAMIC-import version (`computed(() => gmModule?.isGmSdkActive.value)`) had a
// reactivity race: `gmModule` is null until the provider's lazy import resolves
// (post-mount, via `init()`), so a reader that evaluates the computed BEFORE
// then — e.g. the first-play interstitial fired on the first click-to-start —
// gets the `false` fallback AND, because the `?.` short-circuits before reading
// the real ref, only ever tracks the fallback. The later non-reactive
// `gmModule = …` assignment never invalidates it, so `isGmSdkActive` flipping
// true (on SDK_READY) stays invisible and `isInterstitialReady` is stuck false —
// the first-play ad never fires on a fast click. A static import references the
// real refs from module-eval time, so the computeds track them correctly.
//
// Safe for the `2mdn.net` ad-block-probe URL inside `gameMonetizePlugin`: on
// non-GameMonetize builds this whole file is aliased to `GameMonetizeProvider.stub`
// (see `vite.config.ts` resolve.alias), so the real module — and its static
// import of the plugin — is only ever bundled on the GameMonetize build.

import { computed } from 'vue'
import {
  gameMonetizePlugin,
  isGmAdCoolingDown,
  isGmAdsBlocked,
  isGmRewardedFilled,
  isGmSdkActive,
  showMidgameAdGM,
  showRewardedAdGM
} from '@/utils/gameMonetizePlugin'
import type { AdProvider } from './types'

// NOTE: no `ownsAdBlockUi` here — GameMonetize relies on the shared in-game
// `AdsBlockedModal`. Combined with `isGmAdsBlocked`, a failed rewarded tap
// surfaces that modal.

export const createGameMonetizeProvider = (): AdProvider => {
  const isReady = computed(() => isGmSdkActive.value)
  return {
    name: 'gamemonetize',
    isReady,
    // Per-format readiness driven by the plugin's real fill / cooldown signals.
    isRewardedReady: computed(() =>
      isGmSdkActive.value && isGmRewardedFilled.value && !isGmAdCoolingDown.value
    ),
    isInterstitialReady: computed(() =>
      isGmSdkActive.value && !isGmAdCoolingDown.value
    ),
    isAdsBlocked: computed(() => isGmAdsBlocked.value),
    init: async () => {
      try {
        await gameMonetizePlugin()
      } catch (e) {
        console.warn('[ads/gamemonetize] plugin init failed', e)
      }
    },
    showRewardedAd: () => showRewardedAdGM(),
    showMidgameAd: () => showMidgameAdGM()
  }
}
