import { isInternalKey } from './types'
import type {
  HydrateNotice,
  HydrateNoticeListener,
  HydrateState,
  LocalStorageAccessor,
  SaveStrategy
} from './types'
import {
  computeMeta,
  decideMerge,
  META_KEY,
  parseMeta,
  serializeMeta,
  type SaveMeta
} from './SaveMergePolicy'

// ─── Glitch save strategy ──────────────────────────────────────────────────
//
// Persists the entire game save (everything in localStorage) as a single
// Base64-encoded JSON blob in Glitch's save slot 0. We use one slot because
// the game treats save state as atomic — there's no UI for per-feature
// slots and splitting across 99 Glitch slots would multiply API calls
// without benefit.
//
// The Glitch save API adds versioning + conflict detection on top of the
// blob:
//
//   - `base_version` is the version the client last saw. The server
//     rejects an upload with 409 if a newer version exists.
//   - On 409 we call `/resolve` with a policy (defaults to `use_client`,
//     i.e. local wins) so play isn't blocked while we haven't built a
//     resolution UI yet. The strategy exposes a hook so that UI can be
//     bolted on later without editing this file.
//   - A SHA-256 checksum of the raw JSON (pre-Base64) guards against
//     payload corruption in transit. Per Glitch's docs, keys MUST be
//     sorted alphabetically before hashing — otherwise a simple key-
//     insertion-order difference produces a different checksum and the
//     server will flag a spurious conflict. We sort in `collectPayload`.
//
// Guest block:
//   Cloud saves require the GameInstall record to have a `user_email`.
//   Anonymous / guest players get 403 Forbidden. When we see that, we
//   flip the strategy to disabled and surface it via `onGuestBlocked`
//   so the UI can prompt the player to sign in. No further network
//   calls are made until a new GlitchStrategy is constructed.
//
// Size limit:
//   Slots cap out at 10MB. We warn when the encoded payload approaches
//   that limit so the game can react (compress, prune, or surface an
//   error) before the server rejects the upload.
//
// Upstream docs reference:
//   GET  /titles/{title}/installs/{install}/saves
//   POST /titles/{title}/installs/{install}/saves
//   POST /titles/{title}/installs/{install}/saves/{save_id}/resolve

const SLOT_INDEX = 0
const SAVE_TYPE = 'auto'
const FLUSH_DELAY_MS = 750

// Glitch's documented per-slot cap. We warn when the encoded payload
// crosses `SIZE_WARN_BYTES` so we notice before the server 413s.
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024
const SIZE_WARN_BYTES = Math.floor(MAX_PAYLOAD_BYTES * 0.8)

// Keys we track in localStorage internally — these are filtered out of the
// payload so we don't round-trip our own version counters through the save.
const VERSION_KEY = '__save_internal__glitch_version'
const SAVE_ID_KEY = '__save_internal__glitch_save_id'

// Background-retry ladder (mirrors CrazyGamesStrategy). Kicks in when
// hydrate fails so a brief outage at boot heals on its own.
const HYDRATE_RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000]
const HYDRATE_RETRY_LOOP_MS = 900_000  // every 15 min once exhausted

export type ConflictChoice = 'keep_server' | 'use_client'
export type ConflictResolver = (info: {
  conflictId: string
  saveId: string | null
  serverVersion: number
  message: string
}) => Promise<ConflictChoice> | ConflictChoice

export type GuestBlockedHandler = (info: {
  endpoint: 'list' | 'upload' | 'resolve'
  message: string
}) => void

export interface GlitchStrategyConfig {
  titleId: string
  installId: string
  token: string
  /** Override base URL, mainly for tests. Defaults to production. */
  baseUrl?: string
  /**
   * Called when the server rejects an upload as out-of-date. Defaults to
   * `'use_client'` so local play isn't blocked. UI code can inject a
   * prompt here to let the player choose.
   */
  onConflict?: ConflictResolver
  /**
   * Called once when the API returns 403 Forbidden — typically because the
   * player is a guest (no `user_email` on the GameInstall record). The
   * strategy auto-disables after invoking this, so subsequent writes
   * stay local-only. Games should use this hook to prompt for sign-in.
   */
  onGuestBlocked?: GuestBlockedHandler
  /** Injectable for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
}

export class GlitchStrategy implements SaveStrategy {
  readonly name = 'glitch'

  private local: LocalStorageAccessor | null = null
  private baseVersion = 0
  private saveId: string | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  private inflight: Promise<void> | null = null
  private guestBlocked = false
  private _hydrateState: HydrateState = 'pending'
  private retryAttempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private noticeListeners = new Set<HydrateNoticeListener>()
  private readonly fetchImpl: typeof fetch

  constructor(private readonly config: GlitchStrategyConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis)
  }

  get hydrateState(): HydrateState {
    return this._hydrateState
  }

  onHydrateNotice(listener: HydrateNoticeListener): () => void {
    this.noticeListeners.add(listener)
    return () => this.noticeListeners.delete(listener)
  }

  /**
   * True once the backend has returned 403 — the strategy has turned
   * itself off and writes are local-only until the process restarts.
   */
  isGuestBlocked(): boolean {
    return this.guestBlocked
  }

  async hydrate(local: LocalStorageAccessor): Promise<void> {
    this.local = local
    await this.runHydrateAttempt(local)
    if (this._hydrateState === 'failed-retrying') this.scheduleRetry()
  }

  async retryHydrate(local: LocalStorageAccessor): Promise<HydrateState> {
    this.local = local
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    await this.runHydrateAttempt(local)
    if (this._hydrateState === 'failed-retrying') this.scheduleRetry()
    return this._hydrateState
  }

  /** Single attempt at hydrating. Sets hydrateState. Never throws. */
  private async runHydrateAttempt(local: LocalStorageAccessor): Promise<void> {
    // Prime base_version / save_id from a prior session while we wait
    // for the network list call to confirm.
    this.baseVersion = Number(local.get(VERSION_KEY) ?? 0) || 0
    this.saveId = local.get(SAVE_ID_KEY) || null

    let listed: SaveSlot[] | null
    try {
      listed = await this.listSaves()
    } catch (e) {
      console.warn('[save/glitch] list saves failed', e)
      this.setState('failed-retrying', `list failed: ${describeError(e)}`)
      return
    }
    if (this.guestBlocked) {
      // Guest mode is a deterministic answer ("you can't sync"), not a
      // transient failure — treat as success-empty so flushes are no-ops
      // (uploadOnce checks guestBlocked again) and the player keeps
      // playing locally without retry spam.
      this.setState('success-empty', 'guest mode — local-only')
      return
    }
    if (!listed) {
      this.setState('failed-retrying', 'list returned non-array')
      return
    }

    const slot = listed.find(s => s.slot_index === SLOT_INDEX)
    if (!slot) {
      // Fresh install — server confirmed no save exists for this slot.
      // base_version stays 0; flushes can proceed and will create the
      // first server save.
      this.setState('success-empty', 'no remote save')
      this.retryAttempt = 0
      // Push any local writes that arrived before hydrate completed.
      if (this.dirty) this.scheduleFlush()
      return
    }

    this.saveId = slot.id
    this.baseVersion = slot.version
    local.set(SAVE_ID_KEY, slot.id)
    local.set(VERSION_KEY, String(slot.version))

    let remotePayload: Record<string, unknown> | null = null
    try {
      remotePayload = decodePayload(slot.payload)
    } catch (e) {
      console.warn('[save/glitch] decode payload failed', e)
      // Decode failure: corrupt remote save. Treat as failed so we don't
      // overwrite the (possibly-recoverable) local state with garbage.
      this.setState('failed-retrying', 'remote payload decode failed')
      return
    }

    // Run the merge policy: build remote/local meta, decide winner,
    // apply. See SaveMergePolicy.ts for the full contract.
    const remoteRead = (k: string): string | null => {
      const v = remotePayload?.[k]
      return typeof v === 'string' ? v : null
    }
    const remoteMeta: SaveMeta | null =
      parseMeta(remoteRead(META_KEY))
      ?? (remotePayload && Object.keys(remotePayload).length > 0
        ? computeMeta({ get: remoteRead })
        : null)

    const localMeta: SaveMeta | null =
      parseMeta(local.get(META_KEY))
      ?? (anyPayloadKeyPresent(local) ? computeMeta({ get: (k) => local.get(k) }) : null)

    const resolution = decideMerge(localMeta, remoteMeta)

    switch (resolution.kind) {
      case 'remote-only':
      case 'remote-wins': {
        if (remotePayload) {
          for (const [key, value] of Object.entries(remotePayload)) {
            if (key === META_KEY) continue
            if (typeof value === 'string') local.set(key, value)
          }
          if (remoteMeta) local.set(META_KEY, serializeMeta(remoteMeta))
        }
        break
      }
      case 'local-wins':
        // Local already authoritative — flush it back so remote catches up.
        this.dirty = true
        break
      case 'tie-keep-local':
      case 'local-only':
        // Nothing to apply.
        break
    }

    this.retryAttempt = 0
    const hasData = resolution.kind !== 'local-only' || anyPayloadKeyPresent(local)
    this.setState(
      hasData ? 'success-with-data' : 'success-empty',
      resolutionReason(resolution)
    )

    if (this.dirty) this.scheduleFlush()
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
        console.warn('[save/glitch] notice listener threw', e)
      }
    }
  }

  /** Hard guard: NEVER push to remote unless we successfully observed
   *  what the remote contained. Otherwise we risk overwriting cloud data
   *  with fresh-defaults. */
  private canFlush(): boolean {
    if (this.guestBlocked) return false
    return this._hydrateState === 'success-with-data' || this._hydrateState === 'success-empty'
  }

  onLocalSet(_key: string, _value: string): void {
    if (this.guestBlocked) return
    this.dirty = true
    this.scheduleFlush()
  }

  onLocalRemove(_key: string): void {
    if (this.guestBlocked) return
    this.dirty = true
    this.scheduleFlush()
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.canFlush()) return
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
    this.noticeListeners.clear()
  }

  // ─── public hooks ───────────────────────────────────────────────────────

  /** Expose the current conflict-resolution policy for testing / UI. */
  getBaseVersion(): number {
    return this.baseVersion
  }

  getSaveId(): string | null {
    return this.saveId
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return
    if (!this.canFlush()) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.doFlush()
    }, FLUSH_DELAY_MS)
  }

  private async doFlush(): Promise<void> {
    if (!this.canFlush()) return
    if (!this.dirty) return
    // Refresh meta from current local state before serialising the
    // payload so the remote always carries a self-describing snapshot
    // for the next hydrate to merge against.
    if (this.local) {
      this.local.set(META_KEY, serializeMeta(computeMeta({ get: (k) => this.local!.get(k) })))
    }
    // Serialize concurrent flushes — the Glitch API is versioned, and
    // overlapping uploads would fight over base_version.
    if (this.inflight) {
      await this.inflight
      if (!this.dirty) return
    }
    this.dirty = false
    this.inflight = this.uploadOnce().finally(() => {
      this.inflight = null
    })
    await this.inflight
  }

  private async uploadOnce(): Promise<void> {
    const local = this.local
    if (!local || this.guestBlocked) return

    const payload = this.collectPayload(local)
    // JSON.stringify preserves insertion order (ES2015+), and
    // collectPayload builds the object with alphabetically-sorted keys,
    // so both the raw bytes AND the SHA-256 checksum are deterministic
    // across sessions.
    const json = JSON.stringify(payload)
    const bytes = new TextEncoder().encode(json)
    const checksum = await sha256Hex(bytes)
    const b64 = bytesToBase64(bytes)

    // Base64 inflates size by ~33%; the server caps slots at 10MB so we
    // warn once we're within the danger zone and abort outright when the
    // encoded payload would be rejected.
    if (b64.length >= MAX_PAYLOAD_BYTES) {
      console.error(
        `[save/glitch] payload ${b64.length} bytes exceeds 10MB limit — skipping upload (consider compression)`
      )
      this.dirty = true
      return
    }
    if (b64.length >= SIZE_WARN_BYTES) {
      console.warn(
        `[save/glitch] payload ${b64.length} bytes is approaching the 10MB limit`
      )
    }

    const body = {
      slot_index: SLOT_INDEX,
      payload: b64,
      checksum,
      base_version: this.baseVersion,
      save_type: SAVE_TYPE,
      client_timestamp: new Date().toISOString()
    }

    const url = `${this.base()}/titles/${this.config.titleId}/installs/${this.config.installId}/saves`
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.token}`
      },
      body: JSON.stringify(body)
    })

    if (res.status === 201 || res.ok) {
      const data = await parseJson(res)
      const version = Number(data?.data?.version ?? data?.version ?? this.baseVersion + 1)
      this.baseVersion = version
      local.set(VERSION_KEY, String(version))
      return
    }

    if (res.status === 403) {
      await this.markGuestBlocked('upload', res)
      return
    }

    if (res.status === 409) {
      const conflict = await parseJson(res)
      const conflictId = String(conflict?.conflict_id ?? '')
      const serverVersion = Number(conflict?.server_version ?? this.baseVersion + 1)
      const message = String(conflict?.message ?? 'Save conflict')
      const resolver = this.config.onConflict ?? (() => 'use_client' as const)
      const choice = await resolver({
        conflictId,
        saveId: this.saveId,
        serverVersion,
        message
      })
      await this.resolveConflict(conflictId, choice, serverVersion)
      return
    }

    const text = await res.text().catch(() => '')
    console.warn(`[save/glitch] upload failed (${res.status})`, text)
  }

  private async resolveConflict(
    conflictId: string,
    choice: ConflictChoice,
    serverVersion: number
  ): Promise<void> {
    const local = this.local
    if (!local) return

    // If we don't know save_id we can't hit /resolve — fall back to
    // re-POST with the server's version as base. That mimics `use_client`
    // semantics without the dedicated endpoint.
    if (!this.saveId) {
      if (choice === 'use_client') {
        this.baseVersion = serverVersion
        local.set(VERSION_KEY, String(serverVersion))
        this.dirty = true
        await this.uploadOnce()
      } else {
        await this.refreshFromServer(local)
      }
      return
    }

    const url = `${this.base()}/titles/${this.config.titleId}/installs/${this.config.installId}/saves/${this.saveId}/resolve`
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.token}`
        },
        body: JSON.stringify({ conflict_id: conflictId, choice })
      })
      if (res.status === 403) {
        await this.markGuestBlocked('resolve', res)
        return
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        console.warn(`[save/glitch] resolve failed (${res.status})`, text)
        return
      }
      const data = await parseJson(res)
      const version = Number(data?.data?.version ?? serverVersion)
      this.baseVersion = version
      local.set(VERSION_KEY, String(version))
      if (choice === 'keep_server') {
        await this.refreshFromServer(local)
      }
    } catch (e) {
      console.warn('[save/glitch] resolve threw', e)
    }
  }

  private async refreshFromServer(local: LocalStorageAccessor): Promise<void> {
    const listed = await this.listSaves().catch(() => null)
    const slot = listed?.find(s => s.slot_index === SLOT_INDEX)
    if (!slot) return
    this.saveId = slot.id
    this.baseVersion = slot.version
    local.set(SAVE_ID_KEY, slot.id)
    local.set(VERSION_KEY, String(slot.version))
    const payload = decodePayload(slot.payload)
    if (!payload) return
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === 'string') local.set(key, value)
    }
  }

  private async listSaves(): Promise<SaveSlot[] | null> {
    if (this.guestBlocked) return null
    const url = `${this.base()}/titles/${this.config.titleId}/installs/${this.config.installId}/saves`
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.config.token}` }
    })
    if (res.status === 403) {
      await this.markGuestBlocked('list', res)
      return null
    }
    if (!res.ok) return null
    const data = await parseJson(res)
    const arr = data?.data
    return Array.isArray(arr) ? (arr as SaveSlot[]) : null
  }

  /**
   * Build the payload with alphabetically-sorted keys. Glitch's docs
   * require sorted keys so the checksum is deterministic — otherwise
   * insertion-order differences between sessions flip the checksum and
   * the server treats a byte-identical-but-reordered save as a conflict.
   */
  private collectPayload(local: LocalStorageAccessor): Record<string, string> {
    const keys = local
      .keys()
      .filter(k => k !== VERSION_KEY && k !== SAVE_ID_KEY && !isInternalKey(k))
      .sort()
    const out: Record<string, string> = {}
    for (const key of keys) {
      const v = local.get(key)
      if (v != null) out[key] = v
    }
    return out
  }

  private async markGuestBlocked(
    endpoint: 'list' | 'upload' | 'resolve',
    res: Response
  ): Promise<void> {
    if (this.guestBlocked) return
    this.guestBlocked = true
    // Cancel any pending flush — we're done calling the backend until a
    // fresh strategy is constructed (e.g. after the player signs in and
    // bootstraps the game again).
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.dirty = false
    const body = await parseJson(res).catch(() => null)
    const message = String(body?.message ?? 'Guest accounts cannot save to the cloud')
    console.info(`[save/glitch] 403 ${endpoint} — guest block, falling back to local-only`)
    try {
      this.config.onGuestBlocked?.({ endpoint, message })
    } catch (e) {
      console.warn('[save/glitch] onGuestBlocked callback threw', e)
    }
  }

  private base(): string {
    return this.config.baseUrl ?? 'https://api.glitch.fun/api'
  }
}

// ─── wire-format types ─────────────────────────────────────────────────────

interface SaveSlot {
  id: string
  slot_index: number
  version: number
  payload: string
  checksum?: string
  is_conflicted?: boolean
}

// ─── encoding helpers ──────────────────────────────────────────────────────

const decodePayload = (b64: string): Record<string, unknown> | null => {
  try {
    const bytes = base64ToBytes(b64)
    const text = new TextDecoder().decode(bytes)
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

const parseJson = async (res: Response): Promise<any> => {
  try {
    return await res.json()
  } catch {
    return null
  }
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  // btoa operates on binary strings — chunk to avoid "Maximum call stack"
  // on large payloads.
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const anyPayloadKeyPresent = (local: LocalStorageAccessor): boolean => {
  for (const key of local.keys()) {
    if (key === VERSION_KEY || key === SAVE_ID_KEY) continue
    if (!isInternalKey(key) && key !== META_KEY) return true
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

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  // crypto.subtle.digest rejects SharedArrayBuffer-backed typed arrays, so
  // feed it the underlying ArrayBuffer explicitly.
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  const buf = await crypto.subtle.digest('SHA-256', copy.buffer)
  const arr = new Uint8Array(buf)
  let hex = ''
  for (let i = 0; i < arr.length; i++) hex += arr[i]!.toString(16).padStart(2, '0')
  return hex
}
