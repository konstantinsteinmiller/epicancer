import {
  computeMeta,
  decideMerge,
  isPayloadKey,
  META_KEY,
  parseMeta,
  serializeMeta,
  type SaveMeta
} from './SaveMergePolicy'
import type {
  HydrateNotice,
  HydrateNoticeListener,
  HydrateState,
  LocalStorageAccessor,
  SaveStrategy
} from './types'

// ─── CrazyGames data-module strategy (per-key) ─────────────────────────────
//
// Matches the working d797bc9b approach: every allowlisted gameplay key
// gets its own entry on `sdk.data`. A small manifest tracks which keys
// the SDK currently has so hydrate can iterate them on the next session.
// Sorts keys alphabetically before flushing so the wire ordering is
// deterministic across sessions (not strictly required by CG, but the
// same property Glitch needs and a cheap consistency win).
//
// Bulletproofing rules carried over:
//   1. `hydrateState` is set explicitly on every code path. The strategy
//      MUST NOT push to remote unless we observed a `success-*` state —
//      otherwise a transient blip at boot would let fresh-defaults
//      overwrite a real cloud save.
//   2. On a successful hydrate that finds remote data, run the merge
//      resolver: higher progress score wins. The "+N bonus coins" mechanic
//      is intentionally suppressed for CG (no localStorage-vs-cloud
//      divergence to compensate for in cloud-only mode; the resolver
//      would otherwise farm bonus coins on every cold launch).
//   3. When hydrate fails, schedule a background retry ladder
//      (5s → 15s → 45s → 2m → 5m → 15m loop) so a brief outage at boot
//      heals on its own without requiring the player to relaunch.

const KEYS_MANIFEST = '__save_internal__crazy_keys'
const FLUSH_DELAY_MS = 250
const HYDRATE_RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000]
const HYDRATE_RETRY_LOOP_MS = 900_000

// Inline retry inside a single hydrate attempt. The CG SDK occasionally
// returns null for the manifest right after `SDK.init()` resolves — the
// SDK is "ready" but its data module hasn't finished syncing with cloud
// yet. Without this retry, returning players land on stage 1 with their
// cloud save invisible until a background retry (5s+) reads it.
const INLINE_MANIFEST_RETRIES = 2
const INLINE_RETRY_DELAY_MS = 250
const sleepMs = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

interface SdkDataModule {
  getItem: (key: string) => Promise<string | null> | string | null
  setItem: (key: string, value: string) => Promise<void> | void
  removeItem: (key: string) => Promise<void> | void
}

/**
 * Resolves the SDK's data module. Injectable so unit tests can supply a
 * fake without standing up the full `window.CrazyGames` shape.
 */
export type CrazySdkDataGetter = () => SdkDataModule | null

export class CrazyGamesStrategy implements SaveStrategy {
  readonly name = 'crazyGames'

  private _hydrateState: HydrateState = 'pending'
  private local: LocalStorageAccessor | null = null
  private dirty = new Map<string, string | null>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private noticeListeners = new Set<HydrateNoticeListener>()

  // Last value successfully sent to `sdk.data.*` per key. Used by
  // `doFlush` to skip a setItem/removeItem when the value is unchanged
  // from the previous round-trip — cuts redundant SDK writes per CG QA's
  // guidance ("call set only when there are changes"). Value `undefined`
  // means "we removed this key"; `string` means "last set value".
  private lastSentByKey = new Map<string, string | undefined>()

  constructor(private readonly getData: CrazySdkDataGetter) {
  }

  get hydrateState(): HydrateState {
    return this._hydrateState
  }

  async hydrate(local: LocalStorageAccessor): Promise<void> {
    this.local = local
    await this.runHydrateAttempt(local, 'hydrate')
    if (this._hydrateState === 'failed-retrying') this.scheduleRetry()
  }

  async retryHydrate(local: LocalStorageAccessor): Promise<HydrateState> {
    this.local = local
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    await this.runHydrateAttempt(local, 'retry')
    if (this._hydrateState === 'failed-retrying') this.scheduleRetry()
    return this._hydrateState
  }

  onHydrateNotice(listener: HydrateNoticeListener): () => void {
    this.noticeListeners.add(listener)
    return () => this.noticeListeners.delete(listener)
  }

  onLocalSet(key: string, value: string): void {
    if (!isPayloadKey(key)) return
    this.dirty.set(key, value)
    this.trackKey(key)
    this.scheduleFlush()
  }

  onLocalRemove(key: string): void {
    if (!isPayloadKey(key)) return
    this.dirty.set(key, null)
    this.untrackKey(key)
    this.scheduleFlush()
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.doFlush()
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.dirty.clear()
    this.noticeListeners.clear()
  }

  // ─── hydrate path ───────────────────────────────────────────────────────

  /** Single attempt at hydrating from the SDK. Sets hydrateState and
   *  emits a notice on completion. Never throws. */
  private async runHydrateAttempt(local: LocalStorageAccessor, source: 'hydrate' | 'retry'): Promise<void> {
    const data = this.getData()
    if (!data) {
      this.setState('success-empty', source === 'retry' ? 'sdk unavailable' : 'sdk unavailable, local-only')
      return
    }

    let manifestRaw: string | null = null
    let manifestThrew = false
    let manifestError: unknown = null
    for (let attempt = 0; attempt <= INLINE_MANIFEST_RETRIES; attempt++) {
      try {
        const v = await data.getItem(KEYS_MANIFEST)
        manifestRaw = v ?? null
        manifestThrew = false
        manifestError = null
      } catch (e) {
        manifestRaw = null
        manifestThrew = true
        manifestError = e
      }
      if (manifestRaw !== null) break
      if (attempt < INLINE_MANIFEST_RETRIES) {
        await sleepMs(INLINE_RETRY_DELAY_MS)
      } else if (manifestThrew) {
        console.warn('[save/crazy] hydrate manifest failed', manifestError)
        this.setState('failed-retrying', `manifest fetch failed: ${describeError(manifestError)}`)
        return
      }
    }

    const remoteKeys = parseManifest(manifestRaw)

    // Genuine "fresh remote": SDK responded successfully but had no manifest.
    if (manifestRaw === null && remoteKeys.length === 0) {
      this.setState('success-empty', 'remote has no save')
      // Seed cloud with whatever local already has — gameplay state from
      // the current/prior session AND user settings (`spinner_user_*`)
      // present from useUser.ts's module-init writes. `lastSentByKey` is
      // empty here so every local payload key is genuinely new to remote
      // and gets queued.
      this.queueLocalOnlyPayloadKeys(local)
      if (this.dirty.size > 0) this.scheduleFlush()
      return
    }

    // Pull every tracked key. Per-key failures are logged but don't fail
    // the whole attempt — partial data is better than wiping local.
    const remoteSnapshot = new Map<string, string>()
    let perKeyErrors = 0
    const stillNullKeys: string[] = []
    for (const key of remoteKeys) {
      try {
        const value = await data.getItem(key)
        if (value !== null && value !== undefined) {
          const stringified = String(value)
          remoteSnapshot.set(key, stringified)
          // Seed dedupe cache: SDK already has this value, so the next
          // flush should NOT re-send it.
          this.lastSentByKey.set(key, stringified)
        } else {
          stillNullKeys.push(key)
        }
      } catch (e) {
        perKeyErrors++
        console.warn(`[save/crazy] hydrate getItem("${key}") failed`, e)
      }
    }
    // Same SDK-settle defense as the manifest: any key that comes back
    // null on the first call gets one more chance after a short delay.
    if (stillNullKeys.length > 0) {
      await sleepMs(INLINE_RETRY_DELAY_MS)
      for (const key of stillNullKeys) {
        try {
          const value = await data.getItem(key)
          if (value !== null && value !== undefined) {
            const stringified = String(value)
            remoteSnapshot.set(key, stringified)
            this.lastSentByKey.set(key, stringified)
          }
        } catch (e) {
          perKeyErrors++
          console.warn(`[save/crazy] hydrate retry getItem("${key}") failed`, e)
        }
      }
    }
    if (manifestRaw !== null) {
      this.lastSentByKey.set(KEYS_MANIFEST, manifestRaw)
      // Critical for cloud-only mode: sync the cloud manifest into the
      // local accessor (which routes to BlobStorage's internalShadow
      // when `persistToRaw=false`). Without this, `trackKey` reads an
      // empty manifest on the first post-hydrate write, then `doFlush`
      // uploads that single-key list and ORPHANS every other key on
      // sdk.data — the player's whole save appears to vanish on the
      // next refresh. Harmless in per-key-raw mode: the value is
      // already in raw, so `local.set` is a no-op write.
      local.set(KEYS_MANIFEST, manifestRaw)
    }

    // If every per-key fetch failed we don't actually have remote data.
    if (remoteKeys.length > 0 && remoteSnapshot.size === 0 && perKeyErrors > 0) {
      this.setState('failed-retrying', 'all per-key fetches failed')
      return
    }

    // Stronger guard: if the manifest claims payload keys exist but the
    // SDK returned only META_KEY (per-key getItem yielded `null` for
    // every gameplay key), refuse the merge. Without this, a remote-wins
    // decision based on META_KEY's progressScore would write NOTHING to
    // local — the player would see a phantom restore that didn't update
    // their stage / coins / skins.
    if (remoteKeys.length > 0) {
      let payloadKeysReturned = 0
      for (const k of remoteSnapshot.keys()) {
        if (k !== META_KEY && isPayloadKey(k)) payloadKeysReturned++
      }
      if (payloadKeysReturned === 0) {
        this.setState('failed-retrying', 'manifest claims payload keys but SDK returned only META')
        return
      }
    }

    // Build remote / local meta and run the merge resolver.
    const remoteMeta: SaveMeta | null =
      parseMeta(remoteSnapshot.get(META_KEY) ?? null)
      ?? (remoteSnapshot.size > 0
        ? computeMeta({ get: (k) => remoteSnapshot.get(k) ?? null })
        : null)

    const localMeta: SaveMeta | null =
      parseMeta(local.get(META_KEY))
      ?? (anyPayloadKeyPresent(local) ? computeMeta({ get: (k) => local.get(k) }) : null)

    const resolution = decideMerge(localMeta, remoteMeta)

    switch (resolution.kind) {
      case 'remote-only':
      case 'remote-wins': {
        for (const [key, value] of remoteSnapshot) {
          if (key === META_KEY) continue
          local.set(key, value)
        }
        if (remoteMeta) local.set(META_KEY, serializeMeta(remoteMeta))
        // Bonus mechanic disabled wholesale on CG — see strategy header.
        break
      }
      case 'local-wins': {
        // Local already authoritative — flush back so remote catches up.
        for (const key of local.keys()) {
          if (!isPayloadKey(key)) continue
          const v = local.get(key)
          if (v != null) {
            this.dirty.set(key, v)
            this.trackKey(key)
          }
        }
        break
      }
      case 'tie-keep-local':
      case 'local-only':
        break
    }

    // Settings stranding fix: any local payload key whose value differs
    // from the (post-merge) snapshot held in `lastSentByKey` needs to be
    // queued for upload. Catches the case where useUser.ts seeded its
    // ref defaults into localStorage but the player never explicitly
    // re-saved them — without this, settings (`spinner_user_*`) and any
    // other passively-written gameplay keys would live forever in local
    // and never round-trip through `sdk.data`. Per-key dedupe in
    // `doFlush` skips writes already authoritative remotely.
    this.queueLocalOnlyPayloadKeys(local)

    this.retryAttempt = 0
    const hasData = resolution.kind !== 'local-only' || anyPayloadKeyPresent(local)

    this.setState(hasData ? 'success-with-data' : 'success-empty', resolutionReason(resolution))

    if (this.dirty.size > 0) this.scheduleFlush()
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return
    const delay = this.retryAttempt < HYDRATE_RETRY_DELAYS_MS.length
      ? HYDRATE_RETRY_DELAYS_MS[this.retryAttempt]!
      : HYDRATE_RETRY_LOOP_MS
    this.retryAttempt++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      const local = this.local
      if (!local) return
      void this.retryHydrate(local)
    }, delay)
  }

  private setState(state: HydrateState, reason: string): void {
    this._hydrateState = state
    const notice: HydrateNotice = { state, reason }
    for (const fn of this.noticeListeners) {
      try {
        fn(notice)
      } catch (e) {
        console.warn('[save/crazy] notice listener threw', e)
      }
    }
  }

  // ─── flush path ─────────────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return
    if (!this.canFlush()) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.doFlush()
    }, FLUSH_DELAY_MS)
  }

  /** Hard guard: NEVER push to remote unless we successfully observed
   *  what the remote contained. Otherwise we risk overwriting cloud data
   *  with fresh-defaults. */
  private canFlush(): boolean {
    return this._hydrateState === 'success-with-data'
      || this._hydrateState === 'success-empty'
  }

  private async doFlush(): Promise<void> {
    if (!this.canFlush()) return
    const data = this.getData()
    if (!data) return
    if (this.dirty.size === 0) return

    // Refresh META from current local state and queue it alongside the
    // gameplay-key writes so remote always carries a self-describing
    // snapshot for the next hydrate's merge resolver.
    const local = this.local
    if (local) {
      const meta = computeMeta({ get: (k) => local.get(k) })
      const serialized = serializeMeta(meta)
      local.set(META_KEY, serialized)
      this.dirty.set(META_KEY, serialized)
      this.trackKey(META_KEY)
    }

    // Sort the batch alphabetically — deterministic wire ordering across
    // sessions (matches the Glitch strategy's contract; cheap on CG too).
    const batch = [...this.dirty.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    this.dirty = new Map()

    for (const [key, value] of batch) {
      // Dedupe identical writes (saves an SDK round-trip).
      const last = this.lastSentByKey.get(key)
      const wantsRemove = value === null
      const isUnchanged = wantsRemove
        ? last === undefined && this.lastSentByKey.has(key)
        : last === value
      if (isUnchanged) continue
      try {
        if (value !== null) {
          await data.setItem(key, value)
          this.lastSentByKey.set(key, value)
        } else {
          await data.removeItem(key)
          this.lastSentByKey.set(key, undefined)
        }
      } catch (e) {
        console.warn(`[save/crazy] sdk.data sync ("${key}") failed`, e)
        this.dirty.set(key, value)
      }
    }

    // Manifest write (also dedupe'd — every flush would otherwise re-send
    // the same JSON-stringified key list even when only META changed).
    try {
      const manifest = this.readManifest()
      const manifestSerialized = JSON.stringify(manifest)
      if (this.lastSentByKey.get(KEYS_MANIFEST) !== manifestSerialized) {
        await data.setItem(KEYS_MANIFEST, manifestSerialized)
        this.lastSentByKey.set(KEYS_MANIFEST, manifestSerialized)
      }
    } catch (e) {
      console.warn('[save/crazy] manifest sync failed', e)
    }
  }

  // ─── manifest helpers ───────────────────────────────────────────────────

  private readManifest(): string[] {
    if (!this.local) return []
    const raw = this.local.get(KEYS_MANIFEST)
    return parseManifest(raw)
  }

  private writeManifest(keys: string[]): void {
    this.local?.set(KEYS_MANIFEST, JSON.stringify(keys.slice().sort()))
  }

  private trackKey(key: string): void {
    const keys = this.readManifest()
    if (!keys.includes(key)) {
      keys.push(key)
      this.writeManifest(keys)
    }
  }

  private untrackKey(key: string): void {
    const keys = this.readManifest()
    const next = keys.filter(k => k !== key)
    if (next.length !== keys.length) this.writeManifest(next)
  }

  /** Queue every local payload key whose current value differs from the
   *  last value the SDK was observed to hold (or whose key the SDK has
   *  never had at all). Idempotent — `lastSentByKey` is populated by
   *  the per-key fetch loop earlier in hydrate, so a remote-only
   *  resolution sees `lastSent === local` for every cloud-sourced key
   *  and only the genuinely-local-only keys end up queued. */
  private queueLocalOnlyPayloadKeys(local: LocalStorageAccessor): void {
    for (const key of local.keys()) {
      if (!isPayloadKey(key)) continue
      if (key === META_KEY) continue
      const value = local.get(key)
      if (value == null) continue
      if (this.lastSentByKey.get(key) === value) continue
      this.dirty.set(key, value)
      this.trackKey(key)
    }
  }
}

const parseManifest = (raw: unknown): string[] => {
  if (typeof raw !== 'string') return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

const anyPayloadKeyPresent = (local: LocalStorageAccessor): boolean => {
  for (const key of local.keys()) {
    if (isPayloadKey(key) && key !== META_KEY) return true
  }
  return false
}

const describeError = (e: unknown): string => {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

const resolutionReason = (r: { kind: string }): string => {
  switch (r.kind) {
    case 'remote-only':
      return 'restored from cloud'
    case 'remote-wins':
      return 'cloud was ahead — restored'
    case 'local-wins':
      return 'local ahead of cloud — pushing'
    case 'tie-keep-local':
      return 'cloud matches local'
    case 'local-only':
      return 'cloud has no save'
    default:
      return r.kind
  }
}
