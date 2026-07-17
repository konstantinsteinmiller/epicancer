<template lang="pug">
  Transition(name="splash-fade")
    div.splash-backdrop.no-os-ui(v-if="!backdropHidden")

  //- Logo only renders during the loading sequence. Once `done` flips
  //- true (progress = 100% OR the 4s fallback fires), the logo fades out
  //- and unmounts — it deliberately does NOT shrink to the top-left
  //- corner like the previous splash flow.
  Transition(name="logo-fade")
    div.no-os-ui(
      v-if="!done"
      ref="logoRef"
      class="fixed z-[200] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
    )
      div(class="relative flex flex-col items-center")
        div(:style="sizeStyle")
          img(
            :src="logoSrc"
            :alt="t('gameName')"
            class="w-full h-full object-contain"
            draggable="false"
          )

        //- Loading Text
        div.absolute.-bottom-8(class="mt-0 flex flex-col items-center gap-1")
          span(class="percentage-text text-shadow font-mono text-amber-500") {{ Math.round(progress) }}%

        Transition(name="hint-fade")
          div.stuck-hint.mt-4(v-if="showStuckHint") {{ t('loading.tooLong') }}
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import useAssets from '@/use/useAssets'
import { prependBaseUrl } from '@/utils/function'
import { stopLoading } from '@/use/useCrazyGames'
import { armFirstLoadInterstitial, notifySplashGone } from '@/use/useFirstLoadInterstitial'

const { t } = useI18n()

const logoSrc = prependBaseUrl('images/logo/logo_256x256.webp')

const { loadingProgress, preloadAssets } = useAssets()
const progress = computed(() => loadingProgress.value)

void preloadAssets()

// First-load interstitial — kept ON for GamePix only. GameDistribution and
// GameMonetize were intentionally removed: the post-splash ad placement on
// those networks was producing borderline-incidental-click impressions (the
// player taps "play" expecting the game and lands on an ad), so we keep the
// midgame between-rounds interstitial as the sole placement on those builds.
// GamePix portal QA still requires the post-load ad, so its arm stays.
// Every env read is a static literal so Rollup DCEs the entire branch (helper
// module included) on other platform builds — same pattern as the Playgama /
// GamePix loading signals further down.
if (import.meta.env.VITE_APP_GAMEPIX === 'true') {
  armFirstLoadInterstitial()
}

const done = ref(false)
const backdropHidden = ref(false)
const showStuckHint = ref(false)
let stuckHintId: number | null = null

const viewportSize = ref(Math.min(window.innerWidth, window.innerHeight))
const logoRef = ref<HTMLElement | null>(null)

const onResize = () => {
  viewportSize.value = Math.min(window.innerWidth, window.innerHeight)
}

let settleFallbackId: number | null = null

onMounted(() => {
  window.addEventListener('resize', onResize)

  const staticSplash = document.getElementById('static-splash')
  if (staticSplash) {
    staticSplash.classList.add('hidden')
    setTimeout(() => staticSplash.remove(), 500)
  }

  // Hard fallback so the splash always clears, even if the asset loader
  // never reports 100% (offline / blocked images / dropped requests).
  settleFallbackId = window.setTimeout(() => {
    if (!done.value) done.value = true
  }, 4000)
  stuckHintId = window.setTimeout(() => {
    if (!done.value) showStuckHint.value = true
  }, 10000)
})
onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  if (settleFallbackId !== null) clearTimeout(settleFallbackId)
  if (stuckHintId !== null) clearTimeout(stuckHintId)
})

const centeredSize = computed(() => Math.floor(viewportSize.value * 0.4))
const sizeStyle = computed(() => ({
  width: `${centeredSize.value}px`,
  height: `${centeredSize.value}px`
}))

// `immediate: true` fires the handler with the current value the moment
// the watcher is set up. Without it, an asset loader that already reports
// 100% (instant boots, especially on localhost) never trips the watcher
// and the splash sits around for the full 4s `settleFallbackId` window.
watch(progress, (val) => {
  if (val >= 100 && !done.value) {
    setTimeout(() => { done.value = true }, 100)
  }
}, { immediate: true })

let cgLoadSignaled = false
const signalGameReadyToCG = () => {
  if (cgLoadSignaled) return
  cgLoadSignaled = true
  try { stopLoading() } catch (e) { console.warn('[FLogoProgress] CG ready-to-play failed', e) }
}

// Playgama's `game_ready` is certification-mandatory — fire it on the same
// splash-resolved edge as CG's loadingStop. The plugin guards the message
// internally so it fires once even if the watcher re-triggers.
//
// Gate uses the inline `import.meta.env.VITE_APP_*` literal (NOT the
// `isPlaygama` re-export from `useUser`) so Rollup can statically
// eliminate the dynamic-import branch on non-Playgama builds. The
// cross-module constant propagation isn't reliable enough for the
// re-exported `const` to be recognised as a build-time literal, and
// without DCE every build picks up a ~5 KB lazy `playgamaPlugin` chunk
// it never loads. Same pattern in `main.ts`.
let playgamaLoadSignaled = false
const signalGameReadyToPlaygama = () => {
  if (playgamaLoadSignaled) return
  if (import.meta.env.VITE_APP_PLAYGAMA !== 'true') return
  playgamaLoadSignaled = true
  void import('@/utils/playgamaPlugin').then(({ playgamaGameLoadingStop }) => {
    try { playgamaGameLoadingStop() }
    catch (e) { console.warn('[FLogoProgress] Playgama game_ready failed', e) }
  })
}

// GamePix's `gameLoaded` is the analogous certification-critical edge —
// the toolkit's pause/resume self-test requires a complete
// `customLoading → gameLoading(0..100) → gameLoaded` chain or
// `processLoadingEvent` dies on every pause click. The plugin guards the
// `gameLoaded` fire internally so re-triggering is harmless. Same
// `import.meta.env` literal pattern as the Playgama branch above so
// non-GamePix builds DCE the dynamic-import entirely.
let gamepixLoadSignaled = false
const signalGameReadyToGamepix = () => {
  if (gamepixLoadSignaled) return
  if (import.meta.env.VITE_APP_GAMEPIX !== 'true') return
  gamepixLoadSignaled = true
  void import('@/utils/gamepixPlugin').then(({ gamePixGameLoadingStop }) => {
    try { gamePixGameLoadingStop() }
    catch (e) { console.warn('[FLogoProgress] GamePix gameLoaded failed', e) }
  })
}

// Yandex's `LoadingAPI.ready()` is certification-mandatory — fire it on the
// same splash-resolved edge as CG / Playgama / GamePix. Cert text: "At the
// moment when the user can start playing the game, the LoadingAPI.ready()
// method from Game Ready must be called." The plugin guards the call
// internally so re-triggering is harmless. Same `import.meta.env` literal
// pattern as the platform branches above so non-Yandex builds DCE the
// dynamic-import entirely.
let yandexLoadSignaled = false
const signalGameReadyToYandex = () => {
  if (yandexLoadSignaled) return
  if (import.meta.env.VITE_APP_YANDEX !== 'true') return
  yandexLoadSignaled = true
  void import('@/utils/yandexPlugin').then(({ yandexLoadingReady }) => {
    try { yandexLoadingReady() }
    catch (e) { console.warn('[FLogoProgress] Yandex LoadingAPI.ready failed', e) }
  })
}

watch(done, (isDone) => {
  if (isDone) {
    setTimeout(() => {
      backdropHidden.value = true
      signalGameReadyToCG()
      signalGameReadyToPlaygama()
      signalGameReadyToGamepix()
      signalGameReadyToYandex()
      // Triggers the GamePix first-load interstitial (no-op on other builds
      // — the orchestrator was never armed). GD / GameMonetize used to share
      // this fire but were removed above; their first-load ad is gone, the
      // midgame placement is the only ad on those builds now. Runs alongside
      // the platform `game_ready` / `gameLoaded` signals so the ad lands
      // immediately once the splash is gone and the SDK is fillable.
      notifySplashGone()
    }, 150)
  }
})
</script>

<style scoped lang="sass">
.no-os-ui
  caret-color: transparent
  user-select: none
  -webkit-user-select: none
  -webkit-touch-callout: none
  -webkit-tap-highlight-color: transparent

  &, & *
    -webkit-user-drag: none

.percentage-text
  font-size: 1.2rem
  font-weight: bold

.splash-backdrop
  position: fixed
  inset: 0
  z-index: 150
  background-color: #0d2a18
  background-image: url('/images/bg/bg-tile_400x400.webp')
  background-repeat: repeat
  background-size: 400px 400px

.splash-fade-leave-active
  transition: opacity 0.4s ease-out
  pointer-events: none

.splash-fade-leave-to
  opacity: 0

.logo-fade-leave-active
  transition: opacity 0.35s ease-out, transform 0.35s ease-out
  pointer-events: none

.logo-fade-leave-to
  opacity: 0
  transform: translate(-50%, -50%) scale(0.85)

.stuck-hint
  color: rgba(255, 200, 0, 0.85)
  font-size: 0.9rem
  text-align: center
  max-width: 80vw
</style>
