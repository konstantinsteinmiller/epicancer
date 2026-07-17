import { createApp, watch } from 'vue'
import router from '@/router'
import '@/assets/css/tailwind.css'
import '@/assets/css/index.sass'
import { createI18n } from 'vue-i18n'
import {
  loadLocaleMessages,
  resolveInitialLocale,
  setI18nLocale,
  isSupportedLocale
} from '@/i18n'
import { LANGUAGES } from '@/utils/enums'
import { initAds } from '@/use/useAds'
import { installGamePauseAudio } from '@/use/useGamePauseAudio'
import useUser, { isCrazyWeb, isWaveDash, isItch, isGlitch, isGameDistribution, isPlaygama, isGamepix, isGameMonetize, isYandex } from '@/use/useUser'
import { isDebug } from '@/use/useMatch.ts'
import { hasState, reloadMidnightState } from '@/use/useMidnightState'
import { SaveManager } from '@/utils/save/SaveManager'
import { resolveSaveStrategy } from '@/platforms/resolveSaveStrategy'
import { installSaveStatus } from '@/use/useSaveStatus'
import { bootstrapVConsoleFromUrl } from '@/use/useVConsole'

// Build-config self-check moved inline below — the previous top-level
// `looksLikeCrazyGamesPortal` helper baked `crazygames.com` /
// `1001juegos.com` hostname strings into every build's bundle. Yandex's
// moderator flags non-Yandex hostnames as "Service storage URL detected",
// so the check is now an IIFE behind an `import.meta.env.VITE_APP_YANDEX`
// gate (see bootstrap()), letting Rollup DCE the CG strings on Yandex
// builds while keeping the diagnostic alive on every other build.

const bootstrap = async () => {
  // Wire the universal pause gate → audio mute before anything can show an
  // ad. One subscriber, every build: rewarded / interstitial ads, tab-hide,
  // platform SDK pause, and app modals all suspend music + SFX through this
  // and log the transition. Idempotent (useAds also calls it at import).
  installGamePauseAudio()

  // vConsole is mounted on demand via either:
  //   • the StageBadge chord (N taps in 60s) — see `useVConsole.ts`
  //   • a URL query/hash flag (`?vconsole=1` or `#vconsole`)
  //
  // The actual vConsole LIBRARY (~250KB gzipped) is dynamically
  // imported HERE in main.ts — main.ts is in the obfuscator's exclude
  // list, so the bare-specifier dynamic import survives. Rollup
  // splits vConsole into its own lazy chunk that's only fetched when
  // a trigger fires. The `useVConsole.ts` state machine doesn't
  // import the library directly; we install the mounter via
  // `setVConsoleMounter` so vConsole stays out of the main chunk
  // and off the hot path.
  //
  // Why this matters: epicrolla's main bundle ballooned by ~250KB
  // gzipped when vConsole was statically imported. CrazyGames flagged
  // the regression. Putting the dynamic-import here fixes it without
  // breaking the trigger paths.
  //
  // Build-time gate: vConsole is only useful for on-device debugging on
  // native (Tauri) builds — `VITE_APP_NATIVE=true`. On CrazyGames /
  // GameDistribution / Glitch / Itch builds it adds a ~300KB chunk to
  // dist/ that nobody downloads (and CG QA flagged as build dead weight
  // on 2026-04-30). The `import.meta.env`-gated ternary makes the
  // dynamic import unreachable on web builds — Rollup eliminates the
  // import call AND the vconsole chunk entirely.
  //
  // If we ever need vConsole on a web build (e.g. for CG mobile-app QA),
  // set `VITE_APP_INCLUDE_VCONSOLE=true` in the relevant `.env.<mode>`
  // and the `|| ===` arm below pulls it back in.
  if (
    import.meta.env.VITE_APP_NATIVE === 'true'
    || import.meta.env.VITE_APP_INCLUDE_VCONSOLE === 'true'
  ) {
    // vConsole removed from this project (was a epicrolla native-build
    // dependency). To restore on-device debugging, reintroduce the
    // `vconsole` package and wire it back to `setVConsoleMounter`.
    bootstrapVConsoleFromUrl()
  }

  // Build-config self-check. Wrapped in an env-literal gate so the CG
  // hostname strings (`crazygames.com`, `1001juegos.com`) DCE on Yandex
  // builds — Yandex's moderator rejects any non-Yandex hostname as
  // "Service storage URL detected". On every other build the IIFE runs
  // normally and the diagnostic fires if a CG portal hosts a non-CG build.
  if (import.meta.env.VITE_APP_YANDEX !== 'true') {
    const looksLikeCrazyGamesPortal = (): boolean => {
      try {
        const ref = document.referrer
        if (!ref) return false
        const host = new URL(ref).hostname
        return host === 'crazygames.com'
          || host.endsWith('.crazygames.com')
          || host === '1001juegos.com'
          || host.endsWith('.1001juegos.com')
      } catch {
        return false
      }
    }
    if (looksLikeCrazyGamesPortal() && !isCrazyWeb) {
      console.error(
        '[save] BUILD MISCONFIGURED: page is hosted under a CrazyGames portal ' +
        '(referrer=' + document.referrer + ') but VITE_APP_CRAZY_WEB is not "true". ' +
        'CrazyGamesStrategy will NOT run and saves will only land in localStorage. ' +
        'Rebuild with `pnpm build:crazy-web` and ensure .env.crazy-web(.local) sets the flag.'
      )
    }
  }

  // Platform SDK init — must happen before App loads. Each branch runs
  // its platform's adapter via DYNAMIC import so non-matching builds
  // never download the SDK glue. Captured `cgLocale` is read inside the
  // CG arm so the locale-seeding code further down doesn't have to
  // re-import useCrazyGames.
  let cgLocale: string | null = null
  let yaLocale: string | null = null
  if (isCrazyWeb) {
    const cg = await import('@/use/useCrazyGames')
    await cg.initCrazyGames()
    // Explicit `loadingStart` immediately after SDK init. The SDK
    // technically auto-enters the "loading" state on init, but CG QA's
    // tooling does NOT register the load window unless we fire the
    // event ourselves. Without this, the download-size measurement on
    // QA's dashboard ends up empty. The matching `loadingStop` fires
    // from `FLogoProgress.vue` once the splash screen resolves.
    cg.startLoading()
    cgLocale = cg.crazyLocale.value
  } else if (isWaveDash) {
    try {
      const sdk = await (window as any).WavedashJS
      if (sdk) await sdk.init({ debug: isDebug.value })
    } catch (e) {
      console.warn('[Wavedash] SDK init failed:', e)
    }
  } else if (isGamepix) {
    // **Awaited** init — must finish BEFORE `saveManager.init()` runs
    // hydrate. The v3 SDK's `window.GamePix.localStorage.getItem`
    // returns null outside an initialized Player context, so a hydrate
    // that races SDK init reads as empty and the player boots with
    // default state — losing their cloud save on every reload. By the
    // time the SDK fires its first `setItem` (during gameplay), the
    // cloud row holds defaults, not the real progress, and the loss
    // gets committed permanently. CrazyGames takes the same approach
    // (awaits `initCrazyGames()` here for the same reason).
    //
    // The `gamePixGameLoadingStart()` follow-up is intentionally
    // NOT awaited — it opens the toolkit's loading bracket but is
    // otherwise side-effect free, so it can race the rest of boot.
    const { gamepixPlugin, gamePixGameLoadingStart } = await import('@/utils/gamepixPlugin')
    await gamepixPlugin()
    gamePixGameLoadingStart()
  } else if (isYandex) {
    // **Awaited** init — must finish BEFORE `saveManager.init()` runs hydrate.
    // YandexStrategy's `hydrate()` reads `player.getData()` for the
    // authoritative cloud snapshot; without the await, hydrate races SDK init
    // and reads as empty, fresh-defaults overwrite the real cloud save on the
    // next flush, and the cross-device requirement (mandated by Yandex's
    // submission rules) breaks. Same reasoning as GamePix / CrazyGames.
    //
    // Locale is captured from `ysdk.environment.i18n.lang` and routed into
    // `portalLocale` further down so first-time players land on the locale
    // their Yandex Games UI is using (matches the CG / Playgama pattern).
    const { yandexPlugin, yandexLocale } = await import('@/utils/yandexPlugin')
    await yandexPlugin()
    yaLocale = yandexLocale.value
  }

  // Pick the save strategy by build flag. `SaveManager.init()` hydrates
  // localStorage from the chosen backend and then patches
  // `localStorage.setItem` / `removeItem` to mirror writes back. Must
  // resolve before `@/App.vue` is imported because many composables read
  // `localStorage` at module-evaluation time.
  //
  // The branching now lives in `@/platforms/resolveSaveStrategy` so it's
  // unit-testable in isolation. Adding a platform = add an arm there,
  // not edit this file.
  const strategy = await resolveSaveStrategy({
    isCrazyWeb, isWaveDash, isItch, isGlitch, isGameDistribution, isPlaygama, isGamepix, isGameMonetize, isYandex
  })

  // CrazyGames cloud-only mode: gameplay state and our save bookkeeping
  // (`__save_*`) live in memory only; `sdk.data` is the sole persistence
  // backend. CG QA explicitly requires that no `spinner_*` / `ca_*` /
  // `__save_*` keys appear in raw localStorage — only dev toggles
  // (`fps`, `debug`, `cheat`, `campaign-test`, `full_unlocked`) are
  // exempt. Inline env-literal so Vite tree-shakes the dead branch on
  // non-CG builds and the persistToRaw=false path is gone entirely.
  const persistToRaw = import.meta.env.VITE_APP_CRAZY_WEB !== 'true'
  const saveManager = new SaveManager(strategy, window.localStorage, {
    blob: { persistToRaw }
  })
    // Expose immediately, BEFORE the awaited `init()`. CG QA reported that
    // `window.__saveManager` was undefined when probed in the live console;
    // setting it here makes the handle available the moment construction
    // finishes, even if init() hits an unexpected throw before the patches
    // are installed. Lets QA confirm `strategyName === 'crazyGames'` no
    // matter the hydrate timing.
  ;(window as any).__saveManager = saveManager

  // Defense-in-depth `spinner_*` / `ca_*` / `__save_*` safety remove on
  // CG builds. BlobStorage's `scrubRawForCloudOnly()` already wiped these
  // at construction (it seeded into `state` first, so progress is
  // preserved); this second pass catches anything BlobStorage missed.
  // MUST run BEFORE `saveManager.init()` because init patches
  // `localStorage.setItem` / `removeItem` to forward to the strategy —
  // calling the patched removeItem on a `spinner_*` key would issue a
  // cloud delete via `sdk.data.removeItem`, wiping the player's save.
  // Pre-init, `localStorage.removeItem` is still native and these
  // removes are local-only.
  if (import.meta.env.VITE_APP_CRAZY_WEB === 'true') {
    try {
      const stragglers: string[] = []
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i)
        if (k && (k.startsWith('spinner_') || k.startsWith('ca_') || k.startsWith('__save_'))) {
          stragglers.push(k)
        }
      }
      for (const k of stragglers) window.localStorage.removeItem(k)
    } catch { /* harmless */
    }
  }

  // Install the reactive bridge BEFORE init() so the boot-time sanity
  // guard's hydrate-state transitions are observable from useSaveStatus
  // even though no Vue components have mounted yet — the strategy may
  // emit notices via background retries during init.
  installSaveStatus(saveManager)
  await saveManager.init()

  // Refresh the in-memory `mawState` blob from the hydrated localStorage so
  // synchronous reads further down this file (notably `resolveInitialLocale`'s
  // `getState('spinner_user_language')` probe) see the cloud-stored values
  // immediately, NOT the stale pre-hydrate blob. Without this, a returning
  // player whose saved language is 'es' would still get a brief flash of the
  // Yandex / CG portal locale on first paint before the post-hydrate language
  // watcher (further down) reloads and switches. The watcher also calls
  // `reloadMawState()` defensively, so this is the early-flush companion, not
  // a replacement.
  reloadMidnightState()

  // ─── Background / close flush — critical for mobile webviews ───────────
  //
  // On the CrazyGames mobile app (and any other wrapper webview), force-close
  // kills the JS process before the strategy's 500ms debounce or the IDB
  // backup's 1000ms debounce can fire. Without this hook, the player's
  // last few minutes of progress sit in the dirty queue and die with the
  // process — the cloud / IDB never saw them.
  //
  // Two events because each catches a different lifecycle path:
  //   • `visibilitychange` — fires on background/foreground on every modern
  //     mobile WebView. Most reliable signal we get.
  //   • `pagehide` — fires on tab close, navigation away, and on iOS Safari
  //     when the page is being unloaded for memory pressure.
  //
  // Both call SaveManager.flush(), which awaits the strategy's flush AND
  // the backup layer's flush. The OS doesn't wait for our promise, so this
  // is best-effort — the strategy's setItem may not finish before the
  // process is suspended. But it dramatically widens the window where
  // writes complete vs. relying on the natural debounce.
  const flushOnHide = (): void => {
    if (document.visibilityState === 'hidden') {
      void saveManager.flush().catch((e) => {
        console.warn('[save] visibilitychange flush failed', e)
      })
    }
  }
  document.addEventListener('visibilitychange', flushOnHide)
  window.addEventListener('pagehide', () => {
    void saveManager.flush().catch((e) => {
      console.warn('[save] pagehide flush failed', e)
    })
  })

  // NOTE: gates below use `import.meta.env.VITE_APP_*` literals (not the
  // `isGlitch` / `isGameDistribution` constants imported from useUser).
  // Rollup's cross-module constant propagation isn't always reliable, so
  // imported constants don't always tree-shake the dynamic-import branch.
  // Inline literals always do — Vite substitutes them with `'true'` /
  // `'false'` strings at build time, the dead branch is eliminated, and
  // the `await import('@/...')` call (and its target chunk) disappears
  // entirely from non-matching builds.
  if (import.meta.env.VITE_APP_GLITCH === 'true') {
    const { glitchPlugin } = await import('@/utils/glitchPlugin')
    glitchPlugin()
  }

  // GameDistribution: kick off SDK script injection in parallel with the
  // rest of the boot. We don't await — the AdProvider's `init()` (called
  // post-mount via `initAds()`) will await the same promise, so by the
  // time the player can see "watch ad" buttons the SDK is ready. Saves
  // ~1-2 seconds of perceived loading vs awaiting here on the critical
  // path.
  if (import.meta.env.VITE_APP_GAME_DISTRIBUTION === 'true') {
    void import('@/utils/gameDistributionPlugin').then(({ gameDistributionPlugin }) => {
      gameDistributionPlugin()
    })
  }

  // Playgama: same parallel-init pattern as GD. The plugin internally
  // caches its init promise, so the AdProvider + SaveStrategy both join
  // this same `bridge.initialize()` call instead of issuing duplicates.
  // Loading messages are sent immediately after init resolves; the
  // `game_ready` edge is fired later from App.vue's asset-loaded watcher.
  if (import.meta.env.VITE_APP_PLAYGAMA === 'true') {
    void import('@/utils/playgamaPlugin').then(({ playgamaPlugin, playgamaLoadingStart }) => {
      void playgamaPlugin().then(() => playgamaLoadingStart())
    })
  }

  // GameMonetize: same parallel-init pattern as GD / Playgama. The plugin sets
  // `window.SDK_OPTIONS`, lazily injects the SDK script
  // (api.gamemonetize.com/sdk.js), and resolves on SDK_READY. The AdProvider's
  // init() (post-mount via initAds) joins the same cached promise. There's no
  // certification-mandatory loading/ready signal — it's purely an ad SDK.
  if (import.meta.env.VITE_APP_GAME_MONETIZE === 'true') {
    void import('@/utils/gameMonetizePlugin').then(({ gameMonetizePlugin }) => {
      gameMonetizePlugin()
    })
  }

  // GamePix init already ran (awaited) earlier — see the `else if
  // (isGamepix)` branch above. This block intentionally has no GamePix
  // arm: the SDK must be ready before hydrate, so the parallel-init
  // pattern used by Playgama / GD doesn't fit here.

  // CG QA: NO locally-saved data on CG builds — we no longer mirror the
  // CrazyGames-reported locale into sessionStorage. The portal locale is
  // passed straight into resolveInitialLocale below so it influences the
  // first-paint i18n bundle without touching any storage surface.
  // `cgLocale` / `yaLocale` were captured up in their init arms; null on
  // other builds. Yandex returns ISO-639-1 (`en`, `ru`, `tr`, etc.);
  // anything we don't ship maps to the resolver's fallback chain.
  const portalLocaleHint = cgLocale ?? yaLocale
  const portalLocale = portalLocaleHint && LANGUAGES.includes(portalLocaleHint) ? portalLocaleHint : null

  const { default: App } = await import('@/App.vue')

  // Resolve and LOAD just the initial locale bundle before creating the
  // i18n instance. The English fallback is loaded in parallel so missing
  // keys are never undefined while the active locale's chunk is still
  // in flight. If the initial locale IS English we only fetch once.
  const initial = resolveInitialLocale(portalLocale)
  const needsFallback = initial !== 'en'
  const [initialMsgs, fallbackMsgs] = await Promise.all([
    loadLocaleMessages(initial).catch(() => ({})),
    needsFallback ? loadLocaleMessages('en').catch(() => ({})) : Promise.resolve(null)
  ])

  const i18n: any = createI18n({
    locale: initial,
    fallbackLocale: 'en',
    messages: needsFallback
      ? { [initial]: initialMsgs, en: fallbackMsgs ?? {} }
      : { en: initialMsgs },
    missingWarn: false,
    fallbackWarn: false
  })

  // Apply the player's saved language once hydrate finishes. The portal
  // locale (CG / Yandex) is used ONLY to seed first-time players — it
  // never overrides an explicit OptionsModal choice. After hydrate has
  // populated localStorage from cloud, a null value at
  // `spinner_user_language` means "this player has never picked a
  // language on any device" and we can safely seed the portal locale.
  // useUser.ts deliberately does NOT seed a language default, so the
  // null/non-null probe here is a reliable signal.
  {
    const { userLanguage: storedLang, setSettingValue } = useUser()
    const { isDbInitialized: dbReady } = await import('@/use/useMatch')
    let stopLangSync: (() => void) | null = null
    stopLangSync = watch(
      dbReady,
      (ready) => {
        if (!ready) return
        stopLangSync?.()
        // Defensive reload — `main.ts` already calls `reloadMawState()`
        // right after `saveManager.init()` so first-paint reads see the
        // hydrated blob. This second call covers the case where hydrate
        // resolves a cloud value AFTER the early reload (Glitch's HTTP
        // strategy resolves out-of-band in some flows, etc.). Idempotent.
        reloadMidnightState()
        const hasStoredLanguage = hasState('spinner_user_language')
        const portalSeed = cgLocale ?? yaLocale
        if (!hasStoredLanguage && portalSeed && LANGUAGES.includes(portalSeed)) {
          setSettingValue('language', portalSeed)
        }
        // Apply whichever language is now authoritative — the stored
        // value (cloud-hydrated or just-seeded). Never the portal locale
        // unconditionally, because that's what was overwriting an
        // explicit Spanish choice on every English-portal refresh.
        if (isSupportedLocale(storedLang.value)) {
          setI18nLocale(i18n, storedLang.value)
        }
      },
      { immediate: true }
    )
  }

  // Expose the instance globally so composables / skills that want to
  // trigger a runtime locale switch (e.g. OptionsModal) can resolve the
  // active i18n without prop-drilling.
  ;(window as any).__i18n = i18n

  const app = createApp(App)

  app.use(router)
  app.use(i18n)

  app.mount('#app')

  // Kick off the ad provider's init after mount. For CrazyGames the
  // SDK is already up (initCrazyGames ran above) so this is a no-op;
  // for LevelPlay the native bridge needs the Android Activity / iOS
  // ViewController to be alive, which is true once the webview has
  // rendered. Never awaited — ads are not on the critical path, and
  // placements stay hidden via `isAdsReady` until the provider signals
  // ready.
  void initAds().catch((e) => console.warn('[ads] init failed', e))

  // Signal to Wavedash that the game is fully loaded and ready
  if (isWaveDash) {
    try {
      const sdk = await (window as any).WavedashJS
      if (sdk) {
        sdk.updateLoadProgressZeroToOne?.(1)
        sdk.readyForEvents?.()
      }
    } catch (e) {
      console.warn('[Wavedash] ready signal failed:', e)
    }
  }
}

bootstrap()
