// ─── Save Strategy contract ────────────────────────────────────────────────
//
// The game uses the browser's synchronous `localStorage` as the source of
// truth at runtime — ~15 module-level reads fire during app bootstrap and
// many components write back on change. Each environment (plain web,
// CrazyGames, Glitch) layers a different *backend* on top of that local
// mirror to persist progress between devices.
//
// Rather than scatter build-flag branches through every call site, each
// backend is implemented as a `SaveStrategy`. `SaveManager` picks one at
// boot, hydrates localStorage from the backend, then forwards every
// subsequent local write to the strategy. Adding a new backend is a matter
// of implementing this one interface.

/**
 * Narrow accessor passed to strategies so they can read / write
 * localStorage without re-entering the SaveManager's mirror wrappers.
 * Strategies MUST use this instead of `window.localStorage` during
 * hydration, otherwise they'd trigger their own mirror recursively.
 */
export interface LocalStorageAccessor {
  get(key: string): string | null

  set(key: string, value: string): void

  remove(key: string): void

  keys(): string[]
}

/**
 * Lifecycle of a strategy's hydrate path.
 *
 *   pending          → hydrate hasn't started / hasn't completed yet
 *   success-with-data→ remote responded with data; merged into local
 *   success-empty    → remote *confirmed* it has no save data (NOT a network error)
 *   failed-retrying  → couldn't reach remote; background retry loop active
 *   failed-final     → retries exhausted; treat local as authoritative
 *
 * The crucial split is `success-empty` vs `failed-*`. The previous
 * version of the save system collapsed both into "no data, proceed",
 * which let a transient SDK error during boot wipe a player's progress
 * (the game would default to fresh state and the next autosave would
 * push those defaults to the cloud, overwriting the real save). This
 * type forces strategies to declare which one they observed.
 */
export type HydrateState =
  | 'pending'
  | 'success-with-data'
  | 'success-empty'
  | 'failed-retrying'
  | 'failed-final'

/** Optional progress notification emitted by strategies after hydrate. */
export interface HydrateNotice {
  /** Resolved hydrate state after this attempt. */
  state: HydrateState
  /** Short human-readable status useful for the on-screen banner. */
  reason?: string
}

export type HydrateNoticeListener = (notice: HydrateNotice) => void

export interface SaveStrategy {
  /** Short human-readable name used in logs and for testing. */
  readonly name: string

  /** Reactive-friendly snapshot of the current hydrate state. */
  readonly hydrateState: HydrateState

  /**
   * Pull authoritative state from the backend into localStorage. Must
   * resolve before any Vue module reads `localStorage.getItem(...)` at
   * load time — the SaveManager awaits this before the main app graph
   * imports.
   *
   * Strategies MUST set `hydrateState` to one of the terminal values
   * (success-with-data | success-empty | failed-retrying) before
   * resolving. Throwing or leaving state at 'pending' will be treated
   * as failed by the SaveManager.
   *
   * Failure must NOT brick the game — strategies degrade to local-only
   * mode and the manager retries via `retryHydrate` if available.
   */
  hydrate(local: LocalStorageAccessor): Promise<void>

  /**
   * Re-attempt hydrate after a previous failure. Strategies use this
   * for the background retry ladder; the SaveManager also calls it
   * during the boot-time sanity guard. Should be idempotent and safe
   * to invoke from any hydrate state.
   *
   * Returns the new hydrate state after the attempt completes.
   */
  retryHydrate?(local: LocalStorageAccessor): Promise<HydrateState>

  /**
   * Subscribe to hydrate-state changes. Used by the UI status banner.
   * Returns an unsubscribe function. Optional.
   */
  onHydrateNotice?(listener: HydrateNoticeListener): () => void

  /**
   * Called every time application code writes to localStorage (after the
   * local write has already landed). Strategies typically enqueue the
   * change for eventual push to their backend, debounced to avoid
   * hammering the network on rapid game-state writes.
   *
   * IMPORTANT: when `hydrateState` is anything other than `success-*`,
   * the strategy MUST NOT push the change to remote yet — the change
   * stays in a local draft queue and is flushed on the next successful
   * hydrate. This is the rule that prevents the "fresh-defaults
   * overwrite real cloud save" bug.
   */
  onLocalSet(key: string, value: string): void

  /** Companion to onLocalSet for removals. */
  onLocalRemove(key: string): void

  /** Flush any pending writes. Optional — best-effort on page unload. */
  flush?(): Promise<void>

  /** Release resources (timers, listeners). Optional. */
  dispose?(): void
}

/**
 * Keys whose persistence is internal to a strategy (manifests, version
 * counters, etc.). SaveManager never forwards these to `onLocalSet` /
 * `onLocalRemove`, preventing recursion when a strategy writes its own
 * bookkeeping through the wrapped `localStorage.setItem`.
 */
export const INTERNAL_KEY_PREFIX = '__save_internal__'

/**
 * Our own bookkeeping keys (manifests, version counters). Owned by the
 * SaveManager / strategies; never forwarded to `onLocalSet` /
 * `onLocalRemove` because doing so would cause a strategy that writes
 * its own bookkeeping through the wrapped `localStorage.setItem` to
 * recurse on itself.
 */
export const isOwnInternalKey = (key: string): boolean =>
  key.startsWith(INTERNAL_KEY_PREFIX)

/**
 * Keys owned by the CrazyGames SDK's data module — its localStorage
 * availability probes (`__SafeLocalStorage__<timestamp>`) and its cloud
 * cache rows (`SDK_DATA_<id>`). We must never store these in our blob
 * or shadow, never enumerate them via `local.keys()`, and never include
 * them in any payload built for cloud / IDB. The SDK manages them
 * directly through raw localStorage and it is solely responsible for
 * their lifecycle. Touching them caused two regressions:
 *   1. boot-time scan in cloud-only mode was deleting `SDK_DATA_*`
 *      cache rows, defeating the SDK's offline fallback;
 *   2. our patched `setItem` was sinking probe writes into
 *      `internalShadow`, where they accumulated unboundedly until
 *      tab close.
 */
export const isSdkScratchKey = (key: string): boolean =>
  key.startsWith('__SafeLocalStorage__') ||
  key.startsWith('SDK_DATA_')

/**
 * True for keys the SaveManager treats as internal — either our own
 * bookkeeping or SDK scratch. Both are excluded from `onLocalSet` /
 * `onLocalRemove` forwarding to the strategy. Kept as one predicate so
 * the strategy filter (which doesn't care about the distinction) stays
 * a single check.
 */
export const isInternalKey = (key: string): boolean =>
  isOwnInternalKey(key) || isSdkScratchKey(key)
