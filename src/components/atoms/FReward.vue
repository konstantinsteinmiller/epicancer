<template lang="pug">
  Transition(name="fade")
    //- Ensure classes with special characters are in parentheses
    div.fixed.inset-0.flex.flex-col.items-center.justify-center.backdrop-blur-md.touch-none.cursor-pointer(
      v-if="modelValue"
      class="bg-black/60"
      :class="[isAdShowing ? 'z-0' : 'z-[100]', isCompact ? 'p-2' : 'p-4']"
      :style="{\
        paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))',\
        paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',\
        paddingLeft: 'calc(1rem + env(safe-area-inset-left, 0px))',\
        paddingRight: 'calc(1rem + env(safe-area-inset-right, 0px))'\
      }"
      @click="handleOverlayClick"
    )
      //- Parchment-ribbon header. Bitmap background scales to fit the
      //- responsive wrap; the slot content (or a fallback "Rewards"
      //- label) renders on top of the ribbon, centred horizontally and
      //- biased above the bottom curl so the tails stay visible.
      div.ribbon-wrap.relative.mb-10.shrink-0(
        v-if="$slots.ribbon"
        :class="{ '!mb-1 -mt-1 scale-90': isCompact, 'is-desktop': !isCompact && !isMobilePortrait }"
      )
        div.ribbon-banner
          div.ribbon-content
            slot(name="ribbon")
              span.text-white.font-black.uppercase.italic.game-text {{ t('rewards') }}

      //- Content area. In landscape it scrolls inside the remaining height
      //- (min-h-0) so a tall reward block never collides with the inline
      //- "tap to continue" footer below; elsewhere it stays vertically centred.
      div.relative.w-full.flex.flex-col.items-center.justify-center(
        :class="isCompact ? 'flex-1 min-h-0 overflow-y-auto py-1' : 'h-full'"
      )
        slot

      //- Tap-to-continue hint. In landscape it sits INLINE in the flow (shrink-0)
      //- so it can never overlap the centred reward content; otherwise it floats
      //- at the bottom of the viewport as before.
      Transition(name="fade")
        div.flex.justify-center.animate-pulse.pointer-events-none(
          v-if="showContinue"
          :class="isCompact ? 'shrink-0 pt-1 pb-1' : 'absolute bottom-8 left-0 right-0 sm:bottom-12'"
        )
          div.text-white.font-black.uppercase.italic.tracking-widest.brawl-text(
            :class="isCompact ? 'text-xs' : 'text-sm md:text-2xl'"
          )
            | {{ isMobile ? t('tapToContinue') : t('clickToContinue') }}
</template>

<script setup lang="ts">
import { computed, useSlots, watch, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { isMobileLandscape, isMobilePortrait, isShortViewport } from '@/use/useUser'

// "Compact" layout = the short-viewport treatment: mobile landscape OR any
// short embed (≤500px tall, e.g. a CG iframe on a Chromebook). In both cases
// the centred desktop layout overflows, so the ribbon shrinks and the
// tap/click-to-continue hint flows INLINE below the content (shrink-0) instead
// of floating absolutely at the bottom — where it otherwise overlapped the
// reward button.
const isCompact = computed(() => isMobileLandscape.value || isShortViewport.value)
// Sink the reward overlay below the ad layer whenever an interstitial/rewarded
// is on screen. GameMonetize (and several other portals) inject their ad
// container at a z-index lower than this modal's z-[100], so without this the
// modal — including its backdrop-blur — paints OVER the playing ad.
import { isAdShowing } from '@/use/useGamePause'

const props = defineProps<{
  modelValue: boolean
  showContinue: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'continue'): void
}>()

const { t } = useI18n()
const slots = useSlots()

const isMobile = computed(() => {
  return typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)
})

const handleOverlayClick = () => {
  if (props.showContinue) emit('continue')
}

// Desktop shortcut: Space / Enter triggers the same "continue" action
// the overlay click does, but only while the reward is up AND in
// continue-mode. Listener is attached only when the modal becomes
// visible so background views aren't intercepting these keys.
const onContinueKey = (e: KeyboardEvent) => {
  if (!props.modelValue || !props.showContinue) return
  if (e.code !== 'Space' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return
  // Skip when focus is on a typing target — players might be editing
  // toolbar inputs in the background.
  const t = e.target
  if (t instanceof HTMLElement) {
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
    if (t.isContentEditable) return
  }
  e.preventDefault()
  emit('continue')
}

watch(() => props.modelValue, (open) => {
  if (open) window.addEventListener('keydown', onContinueKey)
  else window.removeEventListener('keydown', onContinueKey)
}, { immediate: true })

onUnmounted(() => {
  window.removeEventListener('keydown', onContinueKey)
})
</script>

<style scoped lang="sass">
.fade-enter-active, .fade-leave-active
  transition: opacity 0.4s ease

.fade-enter-from, .fade-leave-to
  opacity: 0

.brawl-text
  text-shadow: 3px 3px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000

// ─── Parchment ribbon ────────────────────────────────────────────────────────

.ribbon-wrap
  position: relative
  width: 80vw
  max-width: 480px

  &.is-desktop
    @media (min-height: 501px)
      width: 70vw
      max-width: 360px

// Parchment ribbon bitmap (553×188 source). The aspect ratio is built
// into the wrap's `aspect-ratio` so the image scales without distorting
// the curled tails. We use `background-image` rather than an `<img>`
// so the slot content can layer cleanly on top without z-index gymnastics.
.ribbon-banner
  position: relative
  aspect-ratio: 553 / 188
  width: 100%
  background-image: url('/images/bg/parchment-ribbon_553x188.webp')
  background-repeat: no-repeat
  background-position: center
  background-size: contain
  display: flex
  align-items: center
  justify-content: center
  filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.5))

.ribbon-content
  position: relative
  // The ribbon art's flat parchment panel sits ABOVE the bottom curl,
  // so the content lifts ~14% of the banner height to land visually
  // centred on that panel.
  margin-top: -14%
  display: flex
  align-items: center
  justify-content: center
  text-align: center
  // Leave generous horizontal room on each side so wider labels don't
  // crash into the tail folds.
  padding: 0 18%

@media (orientation: landscape) and (max-height: 500px)
  .ribbon-wrap
    width: 50vw
    max-width: 400px

// Short but not landscape-mobile (e.g. CG iframe in landscape with the
// portal chrome bar visible — ~700–860 px viewport). The default desktop
// ribbon (max 400 px wide → ~136 px tall) eats too much vertical room
// here, leaving no space for the result text + wheel + spin-again
// buttons. Cap it tighter so the roulette overlay's chrome fits the
// viewport. CG QA caught the overflow 2026-05-05.
@media (orientation: landscape) and (min-height: 501px) and (max-height: 860px)
  .ribbon-wrap.is-desktop
    width: 50vw
    max-width: 320px

</style>
