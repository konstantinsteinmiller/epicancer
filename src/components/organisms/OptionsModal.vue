<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import useUser, { isMobileLandscape } from '@/use/useUser'
import { setI18nLocale } from '@/i18n'
import FModal from '@/components/molecules/FModal.vue'
import FButton from '@/components/atoms/FButton.vue'
import FSlider from '@/components/atoms/FSlider.vue'
import FSelect from '@/components/atoms/FSelect.vue'
import { LANGUAGES, LANGUAGE_AUTONYMS, DIFFICULTY } from '@/utils/enums'

defineProps<{
  isOpen: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

// Global scope so the Options UI strings resolve from the shared locale
// bundles (src/i18n/locales/*) — same source as the rest of the game.
const { t, locale }: any = useI18n({ useScope: 'global' })
const appI18n: any = (window as any).__i18n

const {
  setSettingValue,
  userLanguage,
  userDifficulty,
  userSoundVolume,
  userMusicVolume,
  userMusicTrack
} = useUser()

const currentTab = ref('general')

watch(userLanguage, async (newValue: string) => {
  if (appI18n) {
    await setI18nLocale(appI18n, newValue)
  } else {
    locale.value = newValue
  }
})

const isMobile = computed(() => {
  return typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)
})

const tabs = computed(() => {
  const list = [
    { value: 'general', label: t('options.general') }
  ]
  return !isMobile.value ? list.concat({ label: t('options.audio'), value: 'audio' }) : list
})

// Native-name dropdown — every option legible regardless of the active locale.
const languagesList = computed(() =>
  LANGUAGES.map(loc => ({
    value: loc,
    label: LANGUAGE_AUTONYMS[loc] ?? loc
  }))
)

const difficultyList = computed(() => [
  { value: DIFFICULTY.EASY, label: t('options.difficulties.easy') },
  { value: DIFFICULTY.MEDIUM, label: t('options.difficulties.medium') },
  { value: DIFFICULTY.HARD, label: t('options.difficulties.hard') }
])

const difficultyHint = computed(() => t('options.difficultyHints.' + userDifficulty.value))

// Background-music track picker — Trance Tunnel (default) vs Cozy Harmony.
const musicTrackList = computed(() => [
  { value: 'trance', label: t('options.musicTracks.trance') },
  { value: 'cozy', label: t('options.musicTracks.cozy') }
])
</script>

<template lang="pug">
  FModal(
    :model-value="isOpen"
    :is-closable="false"
    :title="t('options.title')"
    :tabs="tabs"
    v-model:activeTab="currentTab"
    @update:model-value="emit('close')"
  )
    div(v-if="currentTab === 'general'")
      //- Landscape mobile lays the controls out in 2 columns so all of them
      //- (language, difficulty + hint, the two sliders, music track) fit the
      //- short viewport without the SAVE & CLOSE footer overlapping them.
      div(:class="isMobileLandscape ? 'grid grid-cols-2 gap-x-4 gap-y-1 p-1 items-start' : 'flex flex-col gap-2 p-2'")
        div(class="z-[20] flex flex-col gap-2" :class="{ 'scale-80 sm:scale-100': !isMobileLandscape }")
          FSelect(
            class="!text-[10px] md:text-[12px]"
            :label="t('options.language')"
            :options="languagesList"
            :model-value="userLanguage"
            @update:model-value="setSettingValue('language', $event)"
          )
        div(class="z-[10] flex flex-col gap-1" :class="{ 'scale-80 sm:scale-100': !isMobileLandscape }")
          FSelect(
            class="!text-[10px] md:text-[12px]"
            :label="t('options.difficulty')"
            :options="difficultyList"
            :model-value="userDifficulty"
            @update:model-value="setSettingValue('difficulty', $event)"
          )
          p.text-white.game-text.opacity-70.leading-tight.px-1(class="text-[10px] md:text-xs") {{ difficultyHint }}
        hr(v-if="!isMobileLandscape" class="border-slate-600 my-1 md:my-2 pt-0")
        FSlider.px-4(class="!py-1 !pb-3 !max-w-[300px]" :model-value="userSoundVolume" @update:modelValue="setSettingValue('sound', $event)" :label="t('options.soundEffects')" :min="0" :max="1" :step="0.01")
        FSlider.px-4(class="!py-1 !pb-2 !max-w-[300px]" :model-value="userMusicVolume" @update:modelValue="setSettingValue('music', $event)" :label="t('options.music')" :min="0" :max="1" :step="0.01")
        div(class="z-[5] flex flex-col gap-1" :class="{ 'scale-80 sm:scale-100': !isMobileLandscape }")
          FSelect(
            class="!text-[10px] md:text-[12px]"
            :label="t('options.musicTrack')"
            :options="musicTrackList"
            :model-value="userMusicTrack"
            @update:model-value="setSettingValue('musicTrack', $event)"
          )

    div(v-else-if="currentTab === 'audio'").flex.flex-col.justify-between.items-center
      FSlider.px-4(class="!py-1 !pb-3 !max-w-[300px]" :model-value="userSoundVolume" @update:modelValue="setSettingValue('sound', $event)" :label="t('options.soundEffects')" :min="0" :max="1" :step="0.01")
      FSlider.px-4(class="!py-1 !pb-2 !max-w-[300px]" :model-value="userMusicVolume" @update:modelValue="setSettingValue('music', $event)" :label="t('options.music')" :min="0" :max="1" :step="0.01")
      div(class="z-[5] flex flex-col gap-1 w-full max-w-[300px] scale-80 sm:scale-100")
        FSelect(
          class="!text-[10px] md:text-[12px]"
          :label="t('options.musicTrack')"
          :options="musicTrackList"
          :model-value="userMusicTrack"
          @update:model-value="setSettingValue('musicTrack', $event)"
        )
      hr(class="border-slate-600 my-1 md:my-2 pt-0")

    template(#footer)
      FButton(class="px-6 sm:px-8" @click="emit('close')") {{ t('options.close') }}
</template>

<style lang="sass" scoped>
span
  text-shadow: 2px 2px 0 #000
</style>
