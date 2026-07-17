<script setup lang="ts">
import { ref } from 'vue'
import AchievementsModal from '@/components/organisms/AchievementsModal.vue'
import useAchievements from '@/use/useAchievements'

const emit = defineEmits<{
  (e: 'coins-awarded', sourceEl: HTMLElement): void
}>()

const { pendingCount, hasUnclaimed } = useAchievements()
const isModalOpen = ref(false)
</script>

<template lang="pug">
  button.achievements-btn(
    class="cursor-pointer pointer-events-auto active:scale-95 transition-transform scale-80 sm:scale-100"
    :class="{ 'pulse-claim': hasUnclaimed }"
    @click="isModalOpen = true"
  )
    div.relative
      div.absolute.inset-0.translate-y-1.rounded-lg(class="bg-[#7a5a12]")
      div.relative.rounded-lg.border-2.flex.items-center.justify-center.p-2(
        class="bg-gradient-to-b from-[#ffcd00] to-[#f7a000] border-[#0f1a30]"
      )
        //- Trophy glyph — distinct from the BattlePass chevrons.
        svg(viewBox="0 0 24 24" class="w-7 h-7" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round")
          path(d="M7 4 h10 v3 a5 5 0 0 1 -10 0 Z")
          path(d="M7 5 H4 v1 a3 3 0 0 0 3 3")
          path(d="M17 5 h3 v1 a3 3 0 0 1 -3 3")
          path(d="M12 12 v4")
          path(d="M9 20 h6 l-1 -4 h-4 Z")
      //- Pending-claim count badge.
      div.absolute.top-0.right-0.rounded-full.border-2.bg-red-500.border-white.text-white.font-black.game-text.flex.items-center.justify-center(
        v-if="pendingCount > 0"
        class="-translate-y-1 translate-x-1 min-w-4 h-4 px-1 text-[10px]"
      ) {{ pendingCount }}

  AchievementsModal(
    v-model="isModalOpen"
    @coins-awarded="(el) => emit('coins-awarded', el)"
  )
</template>

<style scoped lang="sass">
.pulse-claim
  animation: ach-pulse 1.6s ease-in-out infinite

@keyframes ach-pulse
  0%, 100%
    filter: drop-shadow(0 0 0 rgba(255, 200, 0, 0))
  50%
    filter: drop-shadow(0 0 8px rgba(255, 200, 0, 0.7))
</style>
