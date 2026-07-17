// Wraps the existing CrazyGames SDK integration in the AdProvider shape.
// Init happens in `main.ts` via `initCrazyGames()` (must run before the
// SaveManager hydrates), so this provider's `init()` is a no-op — by the
// time `useAds.initAds()` is called the SDK is already up (or permanently
// inactive on non-CG builds).
//
// The CrazyGames SDK does not expose a per-format `isAdReady` query —
// `requestAd()` always succeeds optimistically and only reports failure
// inside the callback. We therefore mirror `isReady` into both per-format
// gates: when CG is active we assume both formats are showable. The SDK
// will surface "no fill" via the adError callback at request time.
import { computed } from 'vue'
import {
  isCrazyAdsBlocked,
  isSdkActive,
  showMidgameAd,
  showRewardedAd
} from '@/use/useCrazyGames'
import { isCrazyGamesFullRelease } from '@/use/useMatch'
import type { AdProvider } from './types'

export const createCrazyGamesProvider = (): AdProvider => {
  const isReady = computed(() => isSdkActive.value && isCrazyGamesFullRelease)
  return {
    name: 'crazygames',
    isReady,
    isRewardedReady: isReady,
    isInterstitialReady: isReady,
    isAdsBlocked: isCrazyAdsBlocked,
    // CrazyGames renders its own ad-blocker notice, so suppress our shared
    // AdsBlockedModal — otherwise the player sees two stacked popups (CG QA).
    ownsAdBlockUi: true,
    init: async () => {
    },
    showRewardedAd,
    showMidgameAd
  }
}
