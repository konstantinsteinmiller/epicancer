<script setup lang="ts">
// Offline-mode corner banner: when the strategy is in failed-retrying /
// failed-final, tell the player their progress is saved locally but cloud
// sync is paused, and offer a "Retry" button. Tap-to-dismiss. Mounted from
// App.vue.
//
// Epicrolla also used this banner for a conflict-merge coin bonus ("we
// restored your bigger cloud save, here's +N coins"). Midnight Analog has no
// currency to pay a consolation bonus in, so the merge policy just picks the
// higher save and this banner is offline-only.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { isOfflineMode, retryInFlight, retrySync } from '@/use/useSaveStatus'
import { isCrazyWeb } from '@/use/useUser'

const { t } = useI18n()

const offlineDismissed = ref(false)
watch(isOfflineMode, (on) => {
  if (!on) offlineDismissed.value = false
})

// The offline banner says "Playing offline. Your progress is saved here." —
// only TRUE for builds with a local fallback (LocalStorage / Glitch / itch / GD
// / GamePix, all `persistToRaw: true`). CrazyGames is CLOUD-ONLY
// (`persistToRaw: false`), so there is no local save and the message would be a
// lie; the strategy also goes `failed-retrying` whenever `sdk.data` is
// unreachable — which is ALWAYS the case off-portal (localhost / preview),
// flashing a scary banner during dev. The retry ladder still heals silently
// underneath, and CG doesn't mandate an offline notice, so suppress the banner
// on CG entirely.
const showOffline = computed(() => isOfflineMode.value && !offlineDismissed.value && !isCrazyWeb)

const onRetry = async (e: Event) => {
  e.stopPropagation()
  await retrySync()
}

const onDismissOffline = () => {
  offlineDismissed.value = true
}
</script>

<template lang="pug">
  div.fixed.left-2.right-2.z-40.pointer-events-none(class="bottom-2 sm:left-auto sm:right-4 sm:max-w-sm")
    //- Offline banner — amber / informational
    div.pointer-events-auto.rounded-lg.shadow-lg.text-white.text-sm.flex.items-center.gap-3(
      v-if="showOffline"
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
