import { fileURLToPath, URL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'

import { defineConfig, loadEnv, type Plugin } from 'vite'

// ─── Campaign-overrides on-disk persistence ────────────────────────────
// The level editor writes back into `data/campaign-overrides.json` so the
// stages live in the repo (committable, fine-tunable in source) rather
// than only in the user's localStorage. Two surfaces:
//   1. A virtual module `virtual:campaign-overrides` that ships the
//      current JSON as the campaign's seed override map. Resolved at
//      both dev and build time.
//   2. Dev-only middleware:
//        POST /__maw/save-override   { id, stage }   → writes to disk
//        POST /__maw/clear-override  { id }          → removes from disk
//      Production builds don't expose these — the editor button silently
//      falls back to localStorage when the endpoint is absent.
const OVERRIDES_FILE = resolve(
  fileURLToPath(new URL('./data/campaign-overrides.json', import.meta.url))
)
const OVERRIDES_VIRTUAL_ID = 'virtual:campaign-overrides'
const OVERRIDES_RESOLVED = '\0' + OVERRIDES_VIRTUAL_ID

const ensureOverridesFile = () => {
  if (!existsSync(OVERRIDES_FILE)) {
    mkdirSync(dirname(OVERRIDES_FILE), { recursive: true })
    writeFileSync(OVERRIDES_FILE, '{}\n', 'utf-8')
  }
}

const readOverridesJson = (): Record<string, unknown> => {
  ensureOverridesFile()
  try {
    const parsed = JSON.parse(readFileSync(OVERRIDES_FILE, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

const writeOverridesJson = (data: Record<string, unknown>) => {
  ensureOverridesFile()
  writeFileSync(OVERRIDES_FILE, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

const readBody = (req: import('node:http').IncomingMessage): Promise<string> =>
  new Promise((res, rej) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => res(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', rej)
  })

const mawCampaignOverridesPlugin = (): Plugin => ({
  name: 'maw-campaign-overrides',
  resolveId(id) {
    if (id === OVERRIDES_VIRTUAL_ID) return OVERRIDES_RESOLVED
    return null
  },
  load(id) {
    if (id !== OVERRIDES_RESOLVED) return null
    return `export default ${JSON.stringify(readOverridesJson())}`
  },
  configureServer(server) {
    // Hot-reload the virtual module if the JSON file is edited by hand.
    server.watcher.add(OVERRIDES_FILE)
    server.watcher.on('change', (path) => {
      if (resolve(path) !== OVERRIDES_FILE) return
      const mod = server.moduleGraph.getModuleById(OVERRIDES_RESOLVED)
      if (mod) server.moduleGraph.invalidateModule(mod)
      server.ws.send({ type: 'full-reload', path: '*' })
    })

    server.middlewares.use('/__maw/save-override', async (req, res, next) => {
      if (req.method !== 'POST') { next(); return }
      try {
        const body = JSON.parse(await readBody(req)) as { id?: number; stage?: unknown }
        if (typeof body.id !== 'number' || !body.stage) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'expected { id: number, stage }' }))
          return
        }
        const data = readOverridesJson()
        data[String(body.id)] = body.stage
        writeOverridesJson(data)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, id: body.id }))
      } catch (e) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: String((e as Error).message) }))
      }
    })

    server.middlewares.use('/__maw/clear-override', async (req, res, next) => {
      if (req.method !== 'POST') { next(); return }
      try {
        const body = JSON.parse(await readBody(req)) as { id?: number }
        if (typeof body.id !== 'number') {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'expected { id: number }' }))
          return
        }
        const data = readOverridesJson()
        delete data[String(body.id)]
        writeOverridesJson(data)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, id: body.id }))
      } catch (e) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: String((e as Error).message) }))
      }
    })
  }
})

// Read the package version directly so APP_VERSION resolves regardless of
// how vite is invoked. `process.env.npm_package_version` is only set when
// vite runs via `pnpm run <script>` — running `pnpm vite` directly leaves
// it undefined, which makes Vite log the literal define entry as a warning.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8')
) as { version?: string }
const appVersion: string = pkg.version ?? '0.0.0'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import javascriptObfuscator from 'vite-plugin-javascript-obfuscator'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { buildCsp } from './src/platforms/csp'

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  // Load env file based on `mode` in the current working directory.
  // The third parameter '' loads all env vars regardless of VITE_ prefix.
  const env = loadEnv(mode, process.cwd(), '')

  // Only obfuscate during a real production build — never during dev,
  // where the obfuscator rewrites dynamic import strings into lookups
  // Vite can no longer transform, breaking module specifiers at runtime.
  const isProduction = (mode === 'production' || env.VITE_NODE_ENV === 'production') && command === 'build'
  const shouldObfuscate = env.VITE_ENABLE_OBFUSCATION === 'true'

  // Initialize plugins array
  const plugins = []

  // Campaign-overrides plugin — virtual module + dev write endpoints so
  // editor saves persist to `data/campaign-overrides.json` in the repo.
  plugins.push(mawCampaignOverridesPlugin())

  // Only push the obfuscator if both conditions are met
  if (isProduction && shouldObfuscate) {
    console.log('--- 🛡️  Obfuscating Production Build ---')
    plugins.push(
      javascriptObfuscator({
        // Exclude files with dynamic imports — the obfuscator's stringArray
        // rewrites import paths into array lookups that Vite can no longer
        // resolve, which breaks code splitting.
        exclude: [
          /router\/index\.ts$/,
          /main\.ts$/,
          // i18n loader uses `import.meta.glob` for per-locale code
          // splitting — the obfuscator's stringArray rewrites those
          // dynamic paths so rollup can no longer produce separate
          // chunks (every locale ends up inlined in index.js).
          /i18n[\\/]index\.ts$/,
          // resolveSaveStrategy uses `await import('@/...')` inside
          // `import.meta.env.VITE_APP_*`-gated branches so Rollup can
          // tree-shake unused platform plugins. Obfuscation would
          // mangle the dynamic-import literals and break runtime
          // module resolution. (resolveAdProvider stays static-import
          // sync, so it doesn't need an exclude.)
          /platforms[\\/]resolveSaveStrategy\.ts$/,
          // useCrazyGames is the CrazyGames save-strategy delegate that
          // resolveSaveStrategy hands off to. It lazy-loads
          // `@/utils/save/CrazyGamesStrategy` via dynamic import. Without
          // this exclude the obfuscator's stringArray rewrite mangles the
          // literal, Vite can't resolve the `@/` alias, and the browser
          // surfaces `Failed to resolve module specifier
          // '@/utils/save/CrazyGamesStrategy'` at runtime (CG QA flagged
          // it 2026-05-20).
          /use[\\/]useCrazyGames\.ts$/,
          // GameDistributionProvider lazy-loads the heavy
          // `@/utils/gameDistributionPlugin` (~500 LOC) via dynamic
          // import so non-GD builds don't ship the GD SDK code.
          // Same obfuscator-vs-dynamic-import constraint as above.
          /use[\\/]ads[\\/]GameDistributionProvider\.ts$/,
          // PlaygamaProvider lazy-loads `@/utils/playgamaPlugin` for the
          // same reason — keeps the ~280 LOC bridge module off non-Playgama
          // builds. The obfuscator would mangle the dynamic-import literal.
          /use[\\/]ads[\\/]PlaygamaProvider\.ts$/,
          // GamepixProvider lazy-loads `@/utils/gamepixPlugin` so the
          // GamePix SDK glue only ships on GamePix builds. Same
          // obfuscator-vs-dynamic-import constraint as the others.
          /use[\\/]ads[\\/]GamepixProvider\.ts$/,
          // FLogoProgress dynamic-imports `@/utils/playgamaPlugin` and
          // `@/utils/gamepixPlugin` to fire the certification-mandatory
          // `game_ready` / `gameLoaded` edges. Without this exclude the
          // obfuscator wraps the string literal in a stringArray-decoder
          // call expression — Rollup can't statically analyse it for
          // alias resolution, so `@/utils/...` survives into the chunk
          // and the browser surfaces `Failed to resolve module specifier
          // '@/utils/gamepixPlugin'` at runtime.
          //
          // NOTE: no `$` end-anchor — Vue SFCs are presented to the
          // obfuscator's transform hook as virtual paths like
          // `FLogoProgress.vue?vue&type=script&setup=true&lang.ts`,
          // which an anchored regex would miss. Match anywhere on the
          // path so both the raw `.vue` file AND the script-block
          // virtual module are excluded.
          /components[\\/]atoms[\\/]FLogoProgress\.vue/,
          // usePlatformGameplay resolves the active portal's gameplay
          // lifecycle hooks (CrazyGames `startGameplay` / Playgama
          // `gameplayStart`, …) via an `import.meta.env.VITE_APP_*`-gated
          // dynamic import so non-active platforms tree-shake their SDK glue.
          // The obfuscator's stringArray would mangle the dynamic-import
          // literals and break runtime module resolution — same constraint as
          // resolveSaveStrategy above.
          /use[\\/]usePlatformGameplay\.ts$/,
          // useMawCampaign lazy-loads the heavy `useStageBuilder`
          // chunk via `await import('@/use/useStageBuilder')` so all
          // 20 stage builds stay off the boot critical path. The
          // obfuscator's stringArray rewrite would inline the chunk
          // back into the parent, undoing the split.
          /use[\\/]useMawCampaign\.ts$/,
          // useAssets.preloadAssets dynamic-imports the campaign module
          // so the gameplay shared-chunk loads in parallel with the
          // splash render instead of blocking the entry parse. Same
          // obfuscator-vs-dynamic-import constraint as above.
          /use[\\/]useAssets\.ts$/,
          // capabilities.ts has per-platform URL-detector helpers (with
          // hostname literals like `'crazygames'`, `'wavedash'`, `'glitch.fun'`,
          // ...) gated by env-literal IFs so Rollup can tree-shake the dead
          // branches per build. The obfuscator's `stringArray` transform runs
          // BEFORE esbuild's constant folding can fold `import.meta.env.X === 'true'`,
          // baking every hostname into the indirection table regardless of
          // which build is active. Excluding capabilities.ts keeps the
          // constant-fold + tree-shake path intact so on a Yandex build the
          // bundle contains no non-Yandex hostnames — required by Yandex's
          // moderator ("Service storage URL detected").
          /platforms[\\/]capabilities\.ts$/,
          // plattformText.ts is the per-build "available on <hostname>" string
          // mapping. Same obfuscator-vs-stringArray issue as capabilities.ts —
          // the ladder needs env-literal DCE to keep non-active hostnames out
          // of the bundle. The file is intentionally tiny so excluding it
          // doesn't meaningfully reduce obfuscation coverage of App.vue (which
          // still gets obfuscated normally and just imports from this helper).
          /platforms[\\/]plattformText\.ts$/
        ],
        // ─── Obfuscation profile (tuned 2026-04-30) ─────────────────────
        // The previous profile enabled every aggressive transform the
        // plugin offers — `controlFlowFlattening`, `numbersToExpressions`,
        // `splitStrings`, `unicodeEscapeSequence`. Combined they were
        // inflating the bundle by ~3.4× over the unobfuscated baseline
        // (e.g. 217KB → 768KB on the entry chunk for the CrazyGames
        // build flagged by CG QA on 2026-04-30).
        //
        // The transforms removed below all have the same trade-off:
        // huge bundle / runtime cost for protection that any
        // off-the-shelf deobfuscator strips in seconds. Keeping them on
        // costs real users real download time without preventing a
        // motivated reverse-engineer for more than a coffee break.
        //
        // What stays (cheap, useful):
        //   • compact            — single-line output
        //   • simplify           — CFG simplification
        //   • stringArray        — string indirection table
        //   • stringArrayThreshold 0.6 — moderate coverage
        //
        // What was removed (expensive, low-value):
        //   • unicodeEscapeSequence — every `"foo"` → `"foo"`
        //     ~doubles strings on the wire. Trivially reversed.
        //   • splitStrings          — splits every string into 2-char
        //     pieces concatenated at runtime. Triples string size,
        //     interpretable by any human in <1 minute.
        //   • controlFlowFlattening — wraps every block in a switch
        //     dispatcher. ~30% bundle inflation, ~10% runtime perf hit.
        //   • numbersToExpressions  — every literal `5` becomes
        //     `0x4 + 0x1` etc. Bloats math-heavy modules (the canvas
        //     game loop is full of these).
        //
        // If a tighter profile is needed later, prefer enabling
        // `controlFlowFlattening` selectively on a small allowlist of
        // sensitive files (anti-cheat hot paths, license checks) rather
        // than blanket-enabling everywhere.
        options: {
          compact: true,
          simplify: true,
          stringArray: true,
          stringArrayThreshold: 0.6
        }
      } as any)
    )
  }

  // ─── CSP generation ────────────────────────────────────────────────
  // The whole per-platform CSP shape lives in `src/platforms/csp.ts`
  // — extracted so it's unit-testable. Adding a new platform's CSP
  // contribution = edit that file, not this one.
  //
  // YANDEX EXCEPTION: do NOT inject a CSP meta tag on Yandex builds. The
  // game runs inside Yandex's own iframe wrapper, which injects its own
  // production CSP (that's exactly what `@yandex-games/sdk-dev-proxy --csp`
  // fetches + applies during local testing). Our own meta tag is therefore
  // redundant — AND it's the last place in the bundle that names Yandex
  // service hostnames like `yastatic.net` (Yandex's static-storage CDN),
  // `an.yandex.ru`, `yandexadexchange.net`. Yandex's moderation auto-check
  // flags those as "Service storage URL detected" (requirement: no absolute
  // URLs to Yandex service storage in the game's own code). Omitting the
  // meta tag entirely leaves index.html with ZERO Yandex-service URLs and
  // lets Yandex's wrapper own the security policy. The placeholder comment
  // is simply removed so it doesn't ship either.
  const isYandexBuild = env.VITE_APP_YANDEX === 'true'
  // GamePix, like Yandex, hosts the game in its own environment and applies its
  // own CSP. Our meta tag is redundant there and the GamePix testing toolkit's
  // wrapper surfaced it as a `script-src` "blocks the use of 'eval'" violation
  // (the GamePix SDK + its Google ad-creative chain need `eval`/`Function`).
  // Skipping our meta tag on the GamePix build lets GamePix's environment own
  // the policy — same exception we already make for Yandex.
  const isGamepixBuild = env.VITE_APP_GAMEPIX === 'true'
  const skipCspMeta = isYandexBuild || isGamepixBuild
  const cspValue = buildCsp(env)

  plugins.push({
    name: 'inject-csp',
    transformIndexHtml(html: string) {
      return html.replace(
        '<!-- CSP meta tag injected by vite.config.ts at build time -->',
        skipCspMeta
          ? ''
          : `<meta http-equiv="Content-Security-Policy" content="${cspValue}" />`
      )
    }
  })

  // Strip the CrazyGames SDK <script> tag from index.html for non-CrazyGames builds
  // so it doesn't block or error on other platforms (e.g. Wavedash).
  const isCrazyWeb = env.VITE_APP_CRAZY_WEB === 'true'
  if (!isCrazyWeb) {
    plugins.push({
      name: 'strip-crazygames-sdk',
      transformIndexHtml(html: string) {
        return html.replace(
          /<!-- Load the SDK before your game code -->\s*<script[^>]*sdk\.crazygames\.com[^>]*><\/script>\s*/,
          ''
        )
      }
    })
  }

  // Strip the Playgama bridge <script> tag from non-Playgama builds. The
  // build-time tag is mostly a perf shave — the plugin re-injects it at
  // runtime if missing (some QA wrappers serve their own index.html) —
  // but on other portals we don't want an extra DNS lookup to playgama.com.
  const isPlaygama = env.VITE_APP_PLAYGAMA === 'true'
  if (!isPlaygama) {
    plugins.push({
      name: 'strip-playgama-sdk',
      transformIndexHtml(html: string) {
        return html.replace(
          /<!-- Load the SDK before your game code -->\s*<script[^>]*bridge\.playgama\.com[^>]*><\/script>\s*/,
          ''
        )
      }
    })
  }

  // Strip the GamePix SDK <script> tag from non-GamePix builds. Same reason
  // as the Playgama strip — we don't want an extra DNS lookup to
  // integration.gamepix.com on other portals. The plugin polls for
  // `window.GamePix` after init and stays inert if it never appears.
  const isGamepix = env.VITE_APP_GAMEPIX === 'true'
  if (!isGamepix) {
    plugins.push({
      name: 'strip-gamepix-sdk',
      transformIndexHtml(html: string) {
        return html.replace(
          /<!-- Load the SDK before your game code -->\s*<script[^>]*integration\.gamepix\.com[^>]*><\/script>\s*/,
          ''
        )
      }
    })
  }

  // ─── GamePix single-file bundle ─────────────────────────────────────────
  // The GamePix build CDN serves the root `index.html` (200) but intermittently
  // 403s the hashed `assets/*.js` / `assets/*.css` chunks — the 403 body is XML,
  // so the browser refuses the ES module ("blocked due to MIME application/xml")
  // and the app never finishes loading → dead UI, no ad calls. Verified end-to-
  // end in a real browser that the ad chain itself works when assets load, so
  // this is purely the CDN refusing separate chunks. Inline the ENTIRE app
  // (JS + CSS) into index.html for the GamePix build so there are no separate
  // code chunks to refuse — the one file the CDN already serves carries
  // everything. Runtime-URL assets (`images/`, `audio/`, fetched by string URL,
  // not build-time imports) stay external and load fine. GamePix-only; other
  // platforms keep normal code-splitting. Obfuscation is off for GamePix, and
  // the CSP already allows `'unsafe-inline'` scripts on this ad-waterfall build,
  // so the inlined bundle isn't a CSP regression.
  if (isGamepix) {
    // Cast to `any` — the plugin ships its own (mismatched) Vite Plugin types,
    // same reason the obfuscator plugin above is cast.
    plugins.push(viteSingleFile() as any)
  }

  // Emit `playgama-bridge-config.json` ONLY for the Playgama build. NOT
  // served from `public/` because Vite would expose it in dev and in every
  // other platform's `dist/` — which historically baked
  // `forciblySetPlatformId: 'playgama'` and made the bridge hang in
  // localhost / QA-tool contexts (which speak different protocols than
  // the production portal). The config here intentionally OMITS
  // `forciblySetPlatformId` so the bridge auto-detects the right protocol.
  if (isPlaygama) {
    plugins.push({
      name: 'emit-playgama-bridge-config',
      apply: 'build' as const,
      generateBundle() {
        (this as any).emitFile({
          type: 'asset',
          fileName: 'playgama-bridge-config.json',
          source: JSON.stringify({
            advertisement: { minimumDelayBetweenInterstitial: 120 }
          }, null, 2)
        })
      }
    })
  }

  // Foreign-platform code is kept out of the Yandex bundle via `resolve.alias`
  // stubs (see the resolve.alias block below), NOT by deleting emitted chunks.
  //
  // The previous approach — a `generateBundle` hook that DELETED chunks like
  // `gamepixPlugin-*.js` — was fundamentally unsafe: `MawScene.vue` STATICALLY
  // imports `gamePixHappyMoment` from `@/utils/gamepixPlugin`, so Rollup emits
  // gamepixPlugin as a shared chunk that MawScene depends on. Deleting that
  // chunk left MawScene's import dangling → 404 at runtime → "Failed to fetch
  // dynamically imported module: MawScene" → the whole game failed to load on
  // Yandex. Stub-aliasing instead swaps the real module (with its SDK URL) for
  // a tiny no-op module BEFORE bundling, so the URL never enters the build AND
  // the import resolves to a valid chunk. No chunk deletion, no 404.

  return {
    base: '/',
    server: {
      port: 2033
    },
    define: {
      APP_VERSION: JSON.stringify(appVersion)
    },
    plugins: [
      tailwindcss(),
      vue(),
      // vueDevTools(),
      VueI18nPlugin({
        // 1. Tell the plugin where your global translation files are
        include: resolve(dirname(fileURLToPath(import.meta.url)), './src/locales/**'),

        // 2. This allows you to use YAML in the <i18n> block
        // The plugin usually detects yaml automatically, but you can force
        // strict behavior if needed by ensuring the 'yaml' loader is available.
        defaultSFCLang: 'yaml'
      }),
      ...plugins
    ],
    resolve: {
      alias: {
        // On non-CrazyGames builds, redirect `@/use/useCrazyGames` to a
        // no-op stub. The real module contains the literal SDK environment
        // identifier 'crazygames' + `[crazygames]` console log prefixes;
        // many components statically import from it, so its strings end up
        // in the bundle of every build even when the functions are no-ops
        // at runtime. Yandex's moderator flags those non-Yandex identifier
        // strings as "Service storage URL detected", so the alias forces
        // the bundle to use the stub on non-CG builds and the strings stay
        // out entirely. MUST appear BEFORE the `@` / `@/` catch-alls so the
        // more-specific path wins resolution.
        // The other-portal Ad/Save providers are STATICALLY imported by
        // `resolveAdProvider` / `resolveSaveStrategy`. Even on a Yandex build
        // where every `createXxxProvider()` function is dead code (the
        // env-gated arm never executes), the function BODIES — including
        // their `name: 'crazygames'` / `name: 'gamemonetize'` / etc. string
        // literals — live in the chunk. Yandex's moderator flags non-Yandex
        // identifier strings as "Service storage URL detected". Aliasing each
        // foreign-portal provider to a no-op stub on non-active builds keeps
        // the strings out of the bundle entirely. Same pattern for the heavy
        // `useCrazyGames` module which is statically imported by many Vue
        // components for `stopGameplay` / `triggerHappytime` etc.
        ...(env.VITE_APP_CRAZY_WEB === 'true' ? {} : {
          '@/use/useCrazyGames': fileURLToPath(new URL('./src/use/useCrazyGames.stub.ts', import.meta.url)),
          '@/use/ads/CrazyGamesProvider': fileURLToPath(new URL('./src/use/ads/CrazyGamesProvider.stub.ts', import.meta.url))
        }),
        ...(env.VITE_APP_GAME_DISTRIBUTION === 'true' ? {} : {
          '@/use/ads/GameDistributionProvider': fileURLToPath(new URL('./src/use/ads/GameDistributionProvider.stub.ts', import.meta.url))
        }),
        ...(env.VITE_APP_PLAYGAMA === 'true' ? {} : {
          '@/use/ads/PlaygamaProvider': fileURLToPath(new URL('./src/use/ads/PlaygamaProvider.stub.ts', import.meta.url))
        }),
        ...(env.VITE_APP_GAMEPIX === 'true' ? {} : {
          '@/use/ads/GamepixProvider': fileURLToPath(new URL('./src/use/ads/GamepixProvider.stub.ts', import.meta.url)),
          // gamepixPlugin is STATICALLY imported by MawScene.vue (for
          // gamePixHappyMoment), so Rollup emits it as a shared chunk MawScene
          // depends on. The real module hardcodes the GamePix SDK URL
          // (integration.gamepix.com) which Yandex moderation flags. Alias to
          // the stub so the URL never enters the bundle AND MawScene's import
          // resolves to a valid no-op chunk (no 404 — the bug that broke game
          // loading when we tried deleting the chunk instead).
          '@/utils/gamepixPlugin': fileURLToPath(new URL('./src/utils/gamepixPlugin.stub.ts', import.meta.url))
        }),
        ...(env.VITE_APP_GAME_MONETIZE === 'true' ? {} : {
          '@/use/ads/GameMonetizeProvider': fileURLToPath(new URL('./src/use/ads/GameMonetizeProvider.stub.ts', import.meta.url))
        }),
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@/': fileURLToPath(new URL('./src/', import.meta.url)),
        '#': fileURLToPath(new URL('./src/assets', import.meta.url))
      },
      extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue']
    },
    build: {
      minify: 'esbuild',
      // Disable source maps in production if you want maximum protection
      sourcemap: !shouldObfuscate
    }
  }
})
