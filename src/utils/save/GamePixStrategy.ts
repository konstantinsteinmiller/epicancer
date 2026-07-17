// ─── GamePix portal-storage SaveStrategy ───────────────────────────────────
//
// `window.GamePix.localStorage` is the portal-side persistent store that
// survives toolkit-upload iframe-origin churn and syncs across devices
// for signed-in portal players. The v3 SDK does NOT intercept native
// `window.localStorage` writes — games must call `sdk.localStorage.X()`
// explicitly for data to survive. Without this strategy a GamePix build
// would silently fall back to native localStorage and lose progress on
// every fresh upload.
//
// Three properties make this strategy work:
//
//   1. **Boot-race write queue.** `SaveManager.init()` patches
//      `localStorage.setItem` BEFORE `gamepixPlugin()` calls
//      `sdk.init()`. On v3 the `sdk.localStorage` slot only goes live
//      AFTER `init()` resolves — so the first `onLocalSet` calls
//      (boot-time defaults flush, locale autodetect → setSettingValue,
//      a quick OptionsModal toggle) race against SDK init. We queue
//      every pending write in `dirty` (latest value per key wins) and
//      a 250 ms poll flushes them once `sdk.localStorage` becomes
//      reachable. The plugin also triggers an immediate `flush()` from
//      its boot block so the queue drains without waiting for the poll.
//
//   2. **Readback canary.** Outside a real player context (localhost,
//      dev server, developer QA tool when the player isn't signed in),
//      `sdk.localStorage.setItem` is a silent no-op — no throw, no
//      error, but `getItem` always returns null. The only way to
//      detect this is to read back after the first write. Logged once
//      per session so it isn't spammy.
//
//   3. **PORTAL_KEYS allowlist.** Only mirror the consolidated state
//      blob (`maw_state`), NOT internal-scratch keys or debug-only
//      flags. The latter should stay local-only by design — they
//      shouldn't roam across devices.

import type { HydrateState, LocalStorageAccessor, SaveStrategy } from './types'
import { isInternalKey } from './types'
import { STATE_KEY } from '@/use/useMidnightState'
import { META_KEY } from './SaveMergePolicy'
import { isDebug } from '@/use/useMatch'

/** Debug-gated console.info. The hydrate / queue / readback lines fire on
 *  every boot (and harmlessly report "no player" persistence on localhost /
 *  the no-player toolkit), so gate them behind `isDebug` — flip with the
 *  `cmarc` cheat or `localStorage.setItem('debug','true')`. Genuine
 *  exceptions (`… threw`) stay unconditional. */
const dlog = (...args: unknown[]): void => {
  if (isDebug.value) console.info(...args)
}

/** GamePix v3 SDK persistent-storage surface. Shaped like the Web Storage
 *  API, BUT `getItem` is NOT guaranteed synchronous: the documented binding
 *  exposes an async `getItem` (Promise) alongside a `getItemSync`. Different
 *  SDK builds / contexts return either a raw value OR a Promise — the
 *  localhost test SDK returns a string synchronously, while the portal build
 *  resolves a Promise. Treating it as strictly sync (the old bug) meant
 *  `typeof value === 'string'` was false for the Promise, so hydrate mirrored
 *  nothing and the game reset. Methods may also silently no-op when no Player
 *  is logged in ("GamePix Player not found"). */
type MaybePromise<T> = T | Promise<T>
interface GamePixStorage {
  getItem(key: string): MaybePromise<string | null | undefined>
  setItem(key: string, value: string): MaybePromise<void>
  removeItem(key: string): MaybePromise<void>
}

const getGamePixStorage = (): GamePixStorage | null => {
  if (typeof window === 'undefined') return null
  const sdk = (window as unknown as { GamePix?: { localStorage?: GamePixStorage } }).GamePix
  return sdk?.localStorage ?? null
}

/** Read a key from the portal store, tolerating BOTH a sync return and a
 *  Promise. Normalises to `string | null`. Never throws. */
const portalGetItem = async (storage: GamePixStorage, key: string): Promise<string | null> => {
  try {
    const v = await Promise.resolve(storage.getItem(key))
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

/** How long `hydrate` waits for the portal store to surface the player's
 *  STATE blob. The v3 SDK loads `sdk.localStorage` data ASYNCHRONOUSLY after
 *  `sdk.init()` resolves — the storage OBJECT appears first, the player's
 *  data lands a beat (or several hundred ms) later. A naive read right after
 *  init sees `getItem(STATE_KEY) === null`, so the game boots at defaults and
 *  then overwrites the cloud with those defaults. The toolkit's iframe also
 *  wipes native localStorage between reloads, so there is no raw-seed
 *  fallback to mask it — which is why this only reproduces in-portal, never
 *  on localhost (which keeps native localStorage). */
const HYDRATE_DATA_TIMEOUT_MS = 1500

/** Quick portal check used when the local blob ALREADY holds the state (native
 *  storage survived — localhost, or any non-toolkit platform). We still peek
 *  the portal in case it carries a fresher cross-device save, but never block
 *  boot for it: the local seed is a guaranteed fallback. */
const PORTAL_QUICK_MS = 600

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Wait for `window.GamePix.localStorage` to (a) appear AND (b) actually
 *  return the player's STATE blob. Resolves as soon as STATE_KEY reads
 *  non-empty (returning player, data loaded), or after `timeoutMs` with the
 *  store object if it never carries data (genuinely-new player, or the
 *  localhost test SDK where the portal has no player). Returns `null` only
 *  if the store object itself never appears. Awaits each read so an async
 *  (Promise-returning) `getItem` is handled correctly.
 *
 *  Polling avoids coupling the strategy to the plugin's init promise (which
 *  would introduce a cycle: strategy → plugin → save manager → strategy). */
const waitForGamePixStorageData = async (timeoutMs: number): Promise<GamePixStorage | null> => {
  const start = Date.now()
  for (;;) {
    const s = getGamePixStorage()
    if (s) {
      const v = await portalGetItem(s, STATE_KEY)
      if (v !== null && v.length > 0) return s // data is live
    }
    if (Date.now() - start >= timeoutMs) return s ?? null
    await sleep(50)
  }
}

/** Keys whose persistence must round-trip through the portal store.
 *  Everything else (debug flags, cheat toggles, per-component UI state)
 *  stays local-only — those shouldn't roam across devices and the
 *  readback canary would spam if we mirrored every UI write. */
const PORTAL_KEYS: ReadonlySet<string> = new Set([STATE_KEY, META_KEY])

const shouldMirror = (key: string): boolean =>
  !isInternalKey(key) && PORTAL_KEYS.has(key)

const FLUSH_POLL_MS = 250

export class GamePixStrategy implements SaveStrategy {
  readonly name = 'gamepix'
  hydrateState: HydrateState = 'pending'

  /** Pending writes waiting for sdk.localStorage to become reachable.
   *  Latest value wins per key — a burst of slider drags collapses to
   *  a single setItem when the SDK comes up. `null` means "delete". */
  private dirty = new Map<string, string | null>()
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private loggedWriteQueued = false
  private loggedReadbackDiff = false

  async hydrate(local: LocalStorageAccessor): Promise<void> {
    // Wait for the portal store to not just EXIST but actually carry the
    // player's state. On the live portal (and the QA toolkit) the SDK loads
    // `sdk.localStorage` data asynchronously after `sdk.init()` resolves — so
    // a naive read right after init sees `getItem(STATE_KEY) === null` and the
    // game boots at defaults, then overwrites the cloud with those defaults.
    //
    // How long we wait depends on whether there's a local fallback. The
    // toolkit's iframe wipes native localStorage between reloads, so the blob
    // seed (`local`) is EMPTY there and the portal is the only source — we must
    // wait the full timeout for its async data. On localhost (and any platform
    // that keeps native storage) the blob seed already holds the save, so we
    // only do a quick portal check and never block boot — which is why the
    // reset reproduces in-portal but not on localhost.
    const localHasState = (local.get(STATE_KEY)?.length ?? 0) > 0
    const timeout = localHasState ? PORTAL_QUICK_MS : HYDRATE_DATA_TIMEOUT_MS
    const storage = await waitForGamePixStorageData(timeout)
    if (!storage) {
      // `sdk.localStorage` never became reachable. Don't latch `failed-final`
      // — it typically appears shortly after `sdk.init()`; the flush poll
      // started by the first queued write picks it up. `success-empty` keeps
      // SaveManager's sanity-retry from looping.
      if (isDebug.value) console.warn('[gamepix-save] hydrate: sdk.localStorage unreachable → success-empty')
      this.hydrateState = 'success-empty'
      return
    }
    try {
      let mirrored = 0
      for (const key of PORTAL_KEYS) {
        const value = await portalGetItem(storage, key) // tolerates async getItem
        if (value !== null && value.length > 0) {
          local.set(key, value)
          mirrored += 1
          dlog(`[gamepix-save] hydrated ${key} from portal storage (${value.length} bytes)`)
        }
      }
      this.hydrateState = mirrored > 0 ? 'success-with-data' : 'success-empty'
      dlog(`[gamepix-save] hydrate complete (${this.hydrateState}, ${mirrored} key(s))`)
    } catch (e) {
      console.warn('[gamepix-save] hydrate threw', e)
      this.hydrateState = 'failed-final'
    }
  }

  onLocalSet(key: string, value: string): void {
    if (!shouldMirror(key)) return
    const storage = getGamePixStorage()
    if (!storage) {
      this.dirty.set(key, value)
      this.ensureFlushPoll()
      if (!this.loggedWriteQueued) {
        this.loggedWriteQueued = true
        dlog(`[gamepix-save] queued ${key} (sdk.localStorage not yet reachable)`)
      }
      return
    }
    if (this.dirty.size > 0) this.drainDirty(storage)
    try {
      storage.setItem(key, value)
      // Readback canary on the first write — detects the "Player Not Found"
      // silent no-op when running outside a real signed-in portal session.
      // `getItem` may be async, so await it; a Promise-returning setItem also
      // means the readback might race the write — only WARN, never act on it.
      if (!this.loggedReadbackDiff && isDebug.value) {
        void portalGetItem(storage, key).then((readback) => {
          if (readback !== value && !this.loggedReadbackDiff) {
            this.loggedReadbackDiff = true
            console.warn(
              `[gamepix-save] setItem(${key}) accepted but readback differs — ` +
              'portal-side persistence may not be working in this session ' +
              '(likely "Player Not Found" — no real GamePix portal context). ' +
              'Native localStorage still preserves state across reloads on this origin.'
            )
          }
        })
      }
    } catch (e) {
      console.warn(`[gamepix-save] setItem(${key}) threw`, e)
      this.dirty.set(key, value)
      this.ensureFlushPoll()
    }
  }

  onLocalRemove(key: string): void {
    if (!shouldMirror(key)) return
    const storage = getGamePixStorage()
    if (!storage) {
      this.dirty.set(key, null)
      this.ensureFlushPoll()
      return
    }
    if (this.dirty.size > 0) this.drainDirty(storage)
    try {
      storage.removeItem(key)
    } catch (e) {
      console.warn(`[gamepix-save] removeItem(${key}) threw`, e)
      this.dirty.set(key, null)
      this.ensureFlushPoll()
    }
  }

  async flush(): Promise<void> {
    const storage = getGamePixStorage()
    if (!storage) return
    this.drainDirty(storage)
  }

  dispose(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    this.dirty.clear()
  }

  private ensureFlushPoll(): void {
    if (this.flushTimer !== null) return
    this.flushTimer = setInterval(() => {
      const storage = getGamePixStorage()
      if (!storage) return
      this.drainDirty(storage)
      if (this.dirty.size === 0 && this.flushTimer !== null) {
        clearInterval(this.flushTimer)
        this.flushTimer = null
      }
    }, FLUSH_POLL_MS)
  }

  private drainDirty(storage: GamePixStorage): void {
    if (this.dirty.size === 0) return
    const batch = this.dirty
    this.dirty = new Map()
    for (const [key, value] of batch) {
      try {
        if (value === null) storage.removeItem(key)
        else storage.setItem(key, value)
      } catch (e) {
        console.warn(`[gamepix-save] drain ${key} failed`, e)
        this.dirty.set(key, value)
      }
    }
  }
}
