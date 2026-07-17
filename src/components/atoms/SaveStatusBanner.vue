<script setup lang="ts">
// Two-purpose corner banner:
//   1. Offline mode — when the strategy is in failed-retrying / failed-final,
//      tell the player their progress is saved locally but cloud is paused,
//      and offer a "Retry" button.
//   2. Conflict-merge bonus — when a hydrate detected a higher cloud save
//      and we restored it, show the bonus coins so the loss-of-local feels
//      like a gain instead of a punishment. Auto-dismisses after a few sec.
//
// Tap-to-dismiss for both states. Mounted from App.vue.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  acknowledgeBonus,
  bonusCoinsAwarded,
  hasBonusToShow,
  isOfflineMode,
  retryInFlight,
  retrySync
} from '@/use/useSaveStatus'
import { isCrazyWeb } from '@/use/useUser'

const { t } = useI18n()

const dismissed = ref(false)

const offlineDismissed = ref(false)
watch(isOfflineMode, (on) => {
  if (!on) offlineDismissed.value = false
})

// Auto-dismiss the bonus after 6 seconds so it doesn't linger forever.
let bonusTimer: ReturnType<typeof setTimeout> | null = null
watch(bonusCoinsAwarded, (n) => {
  if (n > 0) {
    if (bonusTimer) clearTimeout(bonusTimer)
    bonusTimer = setTimeout(() => acknowledgeBonus(), 6_000)
  }
})
onUnmounted(() => {
  if (bonusTimer) clearTimeout(bonusTimer)
})

// The offline banner says "Playing offline. Your progress is saved here." —
// only TRUE for builds with a local fallback (LocalStorage / Glitch / itch / GD
// / GamePix, all `persistToRaw: true`). CrazyGames is CLOUD-ONLY
// (`persistToRaw: false`), so there is no local save and the message would be a
// lie; the strategy also goes `failed-retrying` whenever `sdk.data` is
// unreachable — which is ALWAYS the case off-portal (localhost / preview),
// flashing a scary banner during dev. The retry ladder still heals silently
// underneath, and CG doesn't mandate an offline notice, so suppress the banner
// on CG entirely. The "cloud save restored" bonus banner is unaffected.
const showOffline = computed(() => isOfflineMode.value && !offlineDismissed.value && !isCrazyWeb)
const showBonus = computed(() => hasBonusToShow.value && !dismissed.value)

const onRetry = async (e: Event) => {
  e.stopPropagation()
  await retrySync()
}

const onDismissOffline = () => {
  offlineDismissed.value = true
}
const onDismissBonus = () => {
  acknowledgeBonus()
  dismissed.value = true
}

// Reset per-show dismiss flag so a future bonus can show again.
watch(hasBonusToShow, (on) => {
  if (on) dismissed.value = false
})
</script>

<template lang="pug">
  div.fixed.left-2.right-2.z-40.pointer-events-none(class="bottom-2 sm:left-auto sm:right-4 sm:max-w-sm")
    //- Bonus banner — green / celebratory
    div.pointer-events-auto.rounded-lg.shadow-lg.text-white.text-sm.flex.items-center.gap-3.cursor-pointer(
      v-if="showBonus"
      class="bg-emerald-700/95 px-3 py-2 mb-2"
      @click="onDismissBonus"
    )
      span.text-xl 🎉
      div.flex-1
        div.font-bold {{ t('saveStatus.restoredTitle') }}
        div.text-xs(class="text-emerald-100") {{ t('saveStatus.restoredBody', { n: bonusCoinsAwarded }) }}
      span.text-xs(class="text-emerald-100/80") {{ t('saveStatus.tap') }}

    //- Offline banner — amber / informational
    div.pointer-events-auto.rounded-lg.shadow-lg.text-white.text-sm.flex.items-center.gap-3(
      v-else-if="showOffline"
      class="bg-amber-700/95 px-3 py-2"
    )
      span.text-xl ☁️
      div.flex-1
        div.font-bold {{ t('saveStatus.pausedTitle') }}
        div.text-xs(class="text-amber-100") {{ t('saveStatus.pausedBody') }}
      button.text-xs.font-bold.rounded.bg-white.text-amber-800(
        class="px-2 py-1 disabled:opacity-50"
        :disabled="retryInFlight"
        @click="onRetry"
      ) {{ retryInFlight ? '…' : t('saveStatus.retry') }}
      button.text-lg.font-bold.px-1(
        class="text-amber-100/80"
        @click="onDismissOffline"
        :aria-label="t('saveStatus.dismiss')"
      ) ×
</template>
