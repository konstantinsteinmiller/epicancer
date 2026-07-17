import type {
  HydrateNoticeListener,
  HydrateState,
  LocalStorageAccessor,
  SaveStrategy
} from './types'
import { isInternalKey } from './types'
import { localLooksFresh as policyLocalLooksFresh } from './SaveMergePolicy'
import { BlobStorage, type BlobStorageOptions } from './BlobStorage'

// ─── SaveManager ───────────────────────────────────────────────────────────
//
// Owns the Strategy, the raw localStorage bindings, and the
// monkey-patching that forwards writes into the strategy. One instance is
// created at boot (`main.ts`) and held as a module-level singleton; game
// code keeps calling plain `localStorage.setItem` unchanged — the manager
// intercepts and forwards.
//
// Boot-time sanity guard:
//   When the initial hydrate does NOT report `success-with-data` AND the
//   local snapshot looks "fresh-defaults" (stage<=1, no coins, no
//   upgrades, no skins), we run up to 3 retries spaced 1s apart before
//   resolving init(). This catches the "transient SDK / network blip
//   during boot" failure mode that was costing returning players their
//   entire progress. The 3-second worst-case delay only applies when
//   both conditions hit, which is precisely the at-risk case. Returning
//   players whose hydrate worked see no added latency.

const BOOT_SANITY_RETRIES = 3
const BOOT_SANITY_DELAY_MS = 1_000

/** Options controlling SaveManager behavior. The `blob` field is
 *  forwarded to the underlying `BlobStorage` — pass
 *  `{ persistToRaw: false }` for cloud-only builds (CrazyGames) where
 *  gameplay state must never appear in raw localStorage. */
export interface SaveManagerOptions {
  blob?: BlobStorageOptions
}

export class SaveManager {
  private readonly storage: Storage
  // Holds gameplay state in memory. Whether that state also mirrors to
  // raw localStorage is controlled by `BlobStorageOptions.persistToRaw`
  // — true for LocalStorage / Glitch / itch / GD; false for CG.
  private readonly blob: BlobStorage
  // Raw bindings captured before we replace the public ones, so the
  // clear() handler can still reach the original `Storage.clear` and
  // enumerate raw entries without re-entering the patched API.
  private readonly rawClear: () => void
  private readonly rawKey: (i: number) => string | null
  private readonly rawLength: () => number

  private patched = false
  private hydrated = false
  private mirroring = false
  private bootCompleteCallbacks: Array<() => void> = []

  constructor(
    private readonly strategy: SaveStrategy,
    storage: Storage = window.localStorage,
    opts: SaveManagerOptions = {}
  ) {
    this.storage = storage
    this.rawClear = storage.clear.bind(storage)
    this.rawKey = storage.key.bind(storage)
    this.rawLength = () => storage.length
    this.blob = new BlobStorage(storage, opts.blob)
  }

  /** Strategy name — useful for logs/tests. */
  get strategyName(): string {
    return this.strategy.name
  }

  /**
   * Forward a key/value to the strategy WITHOUT writing to localStorage.
   * Use for state that should sync to remote but doesn't need to live on
   * device (e.g. cross-device counters, leaderboard scratch). Internal
   * keys are filtered out. On `LocalStorageStrategy` (no remote backend)
   * this is a no-op.
   */
  setRemoteOnly(key: string, value: string): void {
    if (isInternalKey(key)) return
    try {
      this.strategy.onLocalSet(key, value)
    } catch (e) {
      console.warn(`[save] setRemoteOnly("${key}") threw`, e)
    }
  }

  /** Companion to setRemoteOnly for explicit removals. */
  removeRemoteOnly(key: string): void {
    if (isInternalKey(key)) return
    try {
      this.strategy.onLocalRemove(key)
    } catch (e) {
      console.warn(`[save] removeRemoteOnly("${key}") threw`, e)
    }
  }

  /** Current hydrate state from the underlying strategy. Live —
   *  changes as background retries run. */
  get hydrateState(): HydrateState {
    return this.strategy.hydrateState
  }

  isHydrated(): boolean {
    return this.hydrated
  }

  /** Subscribe to hydrate-state notices from the strategy. Returns
   *  an unsubscribe function. Used by the on-screen status banner. */
  onHydrateNotice(listener: HydrateNoticeListener): () => void {
    return this.strategy.onHydrateNotice?.(listener) ?? (() => {
    })
  }

  /** Trigger a manual hydrate retry. Used by the "Retry sync" button
   *  on the offline banner. Returns the new hydrate state. */
  async retryHydrate(): Promise<HydrateState> {
    if (!this.strategy.retryHydrate) return this.strategy.hydrateState
    return this.strategy.retryHydrate(this.localAccessor())
  }

  /**
   * Subscribe to the one-shot "boot complete" event fired AFTER `init()`
   * patches localStorage. Composables that need to refresh refs from
   * cloud-hydrated state (via `useSaveStatus`'s `saveDataVersion` bump)
   * MUST listen here rather than to `onHydrateNotice` — strategy
   * notices fire from inside `hydrate()`, before patches are installed,
   * which means any `localStorage.getItem` from a watcher callback
   * would hit the un-patched raw storage and miss the cloud values
   * BlobStorage just loaded into its in-memory state.
   *
   * If `init()` already completed before the listener is registered,
   * the callback fires synchronously on registration so late
   * subscribers don't miss the boot signal.
   */
  onBootComplete(callback: () => void): () => void {
    if (this.hydrated) {
      try {
        callback()
      } catch (e) {
        console.warn('[save] onBootComplete callback threw', e)
      }
      return () => {
      }
    }
    this.bootCompleteCallbacks.push(callback)
    return () => {
      this.bootCompleteCallbacks = this.bootCompleteCallbacks.filter(c => c !== callback)
    }
  }

  private fireBootComplete(): void {
    const callbacks = this.bootCompleteCallbacks
    this.bootCompleteCallbacks = []
    for (const cb of callbacks) {
      try {
        cb()
      } catch (e) {
        console.warn('[save] onBootComplete callback threw', e)
      }
    }
  }

  /**
   * Hydrate the in-memory state from the backend, then patch
   * `localStorage.setItem` / `removeItem` so all future writes flow
   * through the strategy. Idempotent.
   *
   * MUST be awaited before the Vue app module graph loads, because
   * many composables read `localStorage.getItem(...)` at module
   * evaluation time.
   */
  async init(): Promise<void> {
    if (this.hydrated) return
    this.mirroring = true
    const local = this.localAccessor()

    try {
      await this.strategy.hydrate(local)
    } catch (e) {
      console.warn(`[save] hydrate failed (${this.strategy.name})`, e)
    }

    // Boot-time sanity guard: if the strategy didn't end up with
    // `success-with-data` AND local looks like a fresh-defaults install,
    // try a few quick retries before letting the app boot.
    if (this.strategy.retryHydrate && shouldRunSanityGuard(this.strategy.hydrateState, local)) {
      for (let i = 0; i < BOOT_SANITY_RETRIES; i++) {
        await sleep(BOOT_SANITY_DELAY_MS)
        const newState = await this.strategy.retryHydrate(local).catch((e): HydrateState => {
          console.warn('[save] sanity-guard retry threw', e)
          return this.strategy.hydrateState
        })
        if (newState === 'success-with-data' || newState === 'success-empty') break
      }
    }

    this.mirroring = false

    this.patchLocalStorage()
    this.hydrated = true
    // Fire ONLY after patches are in place. Composables relying on
    // `saveDataVersion` (via `useSaveStatus.installSaveStatus`) bump
    // here so their `localStorage.getItem` reads route through the
    // BlobStorage proxy and pick up the cloud-hydrated state.
    this.fireBootComplete()
  }

  /** Flush any pending writes. Best-effort — safe to await on unload. */
  async flush(): Promise<void> {
    await this.strategy.flush?.()
  }

  /** Release timers / listeners held by the strategy. */
  dispose(): void {
    this.strategy.dispose?.()
  }

  // ─── internals ──────────────────────────────────────────────────────────

  /** Strategy-facing accessor. Reads and writes go through BlobStorage,
   *  which routes gameplay keys to the in-memory map (mirrored per-key
   *  into raw localStorage) and bypass keys straight through to raw. */
  private localAccessor(): LocalStorageAccessor {
    return {
      get: (key) => this.blob.get(key),
      set: (key, value) => {
        this.blob.set(key, value)
      },
      remove: (key) => {
        this.blob.remove(key)
      },
      keys: () => this.blob.keys()
    }
  }

  private patchLocalStorage(): void {
    if (this.patched) return
    this.patched = true

    // ── Why this isn't a simple `localStorage.getItem = fn` assignment:
    //
    // Web Storage objects are `[LegacyOverrideBuiltIns]` platform objects.
    // Their methods live on `Storage.prototype`, not on the instance.
    //
    //   Direct assignment   `localStorage.getItem = fn`
    //   In Firefox + some Chromium variants (Opera, certain incognito
    //   modes) this routes through the named-property setter and turns
    //   into `localStorage.setItem('getItem', fn.toString())` — the
    //   override never lands.
    //
    //   Instance defineProperty   `Object.defineProperty(localStorage,
    //   'getItem', {value: fn})`
    //   Better, but CG QA reported on 2026-05-05 that even with this
    //   technique Opera + Firefox still hit the data-loss bug
    //   (`spinner_player_max_stage` overwritten with `1` on every load).
    //   The own data property either doesn't shadow the prototype method,
    //   or some browser-internal lookup path bypasses it.
    //
    //   Proxy on `window.localStorage`   ← THIS IS THE FIX
    //   Replace `window.localStorage` with a Proxy wrapping the original
    //   storage. Every `localStorage.X` access in user code goes through
    //   the Proxy's `get` trap, so we control the dispatch unambiguously
    //   regardless of named-property-setter semantics. BlobStorage's
    //   `rawGet` / `rawSet` were captured in its constructor BEFORE
    //   patching, so they keep accessing the original storage and do NOT
    //   recurse through the proxy.
    const blob = this.blob
    const strategy = this.strategy
    const isMirroring = (): boolean => this.mirroring
    const rawClear = this.rawClear
    const rawKey = this.rawKey
    const rawLength = this.rawLength

    const patchedGetItem = (key: string): string | null => blob.get(key)

    const patchedSetItem = (key: string, value: string): void => {
      const changed = blob.set(key, value)
      if (isMirroring() || isInternalKey(key)) return
      if (!changed) return
      try {
        strategy.onLocalSet(key, value)
      } catch (e) {
        console.warn(`[save] onLocalSet("${key}") threw`, e)
      }
    }

    const patchedRemoveItem = (key: string): void => {
      const changed = blob.remove(key)
      if (isMirroring() || isInternalKey(key)) return
      if (!changed) return
      try {
        strategy.onLocalRemove(key)
      } catch (e) {
        console.warn(`[save] onLocalRemove("${key}") threw`, e)
      }
    }

    // `clear()` wipes raw localStorage AND the in-memory state, then
    // emits a removeItem for every non-internal key so the strategy
    // stays in sync.
    const patchedClear = (): void => {
      const all: string[] = []
      for (let i = 0; i < rawLength(); i++) {
        const k = rawKey(i)
        if (k !== null) all.push(k)
      }
      blob.clear()
      rawClear()
      for (const k of all) {
        if (isInternalKey(k)) continue
        try {
          strategy.onLocalRemove(k)
        } catch (e) {
          console.warn(`[save] onLocalRemove (clear) threw`, e)
        }
      }
    }

    const proxy = new Proxy(this.storage, {
      get(target, prop) {
        if (prop === 'getItem') return patchedGetItem
        if (prop === 'setItem') return patchedSetItem
        if (prop === 'removeItem') return patchedRemoveItem
        if (prop === 'clear') return patchedClear
        // Pass-through for `length`, `key(i)`, and any named-property
        // reads. Functions need to be bound so `this` resolves to the
        // underlying Storage and not the proxy (re-entering the proxy
        // would just resolve back through the same getters).
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? (value as Function).bind(target) : value
      }
    })

    if (typeof window !== 'undefined' && this.storage === window.localStorage) {
      // Production path: replace `window.localStorage` with the proxy.
      // `defineProperty` (not direct assignment) so it survives even
      // browsers where Window's localStorage descriptor is non-writable.
      try {
        Object.defineProperty(window, 'localStorage', {
          value: proxy,
          configurable: true,
          writable: true
        })
      } catch (e) {
        console.warn('[save] failed to install localStorage proxy', e)
      }
    } else {
      // Test / non-browser path: proxy isn't reachable through
      // `window.localStorage` (the test passed in a custom Storage).
      // Fall back to instance-level `defineProperty` so direct
      // references to `this.storage` still resolve to the patched
      // methods.
      const define = (name: string, value: unknown) => {
        Object.defineProperty(this.storage, name, { value, configurable: true, writable: true })
      }
      define('getItem', patchedGetItem)
      define('setItem', patchedSetItem)
      define('removeItem', patchedRemoveItem)
      define('clear', patchedClear)
    }

    // Self-check: write+read a sentinel through the patched accessors.
    // If the proxy isn't reachable (e.g. the browser blocked the
    // window-property override) the round-trip will return the wrong
    // value and we log loudly so future regressions surface in the
    // QA console instead of silently corrupting cloud saves.
    try {
      const sentinel = '__save_internal__patch_sentinel'
      const probeValue = String(Date.now())
      const ls = typeof window !== 'undefined' ? window.localStorage : this.storage
      ls.setItem(sentinel, probeValue)
      const echoed = ls.getItem(sentinel)
      ls.removeItem(sentinel)
      if (echoed !== probeValue) {
        console.error(
          '[save] patchLocalStorage self-check FAILED — patched setItem/getItem ' +
          'are not routing through SaveManager. Cloud progress will not be loaded ' +
          'on this browser.', { expected: probeValue, got: echoed }
        )
      }
    } catch (e) {
      console.warn('[save] patchLocalStorage self-check threw', e)
    }
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

const shouldRunSanityGuard = (state: HydrateState, local: LocalStorageAccessor): boolean => {
  if (state === 'success-with-data') return false
  if (state === 'success-empty') return false
  return localLooksFresh(local)
}

const localLooksFresh = (local: LocalStorageAccessor): boolean =>
  policyLocalLooksFresh({ get: (k) => local.get(k) })

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
