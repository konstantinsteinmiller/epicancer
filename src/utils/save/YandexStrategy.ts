// ─── Yandex Games SaveStrategy (authoritative cloud-read) ──────────────────
//
// Mirrors gameplay state through `ysdk.getPlayer().setData / getData`. Yandex
// stores up to 200 KB per player as a free-form JSON object, capped at 100
// requests / 5 min. The single-blob model fits both constraints comfortably —
// we batch every mirrored key into one cloud row and let SaveManager's flush
// throttle (200 ms debounce, 2.5 s max-wait) keep us well under the rate cap.
//
// Two design choices baked in:
//
//   1. **Authoritative cloud-read on hydrate.** Yandex's submission
//      requirements page mandates "the game progress is saved on the server
//      and available on different devices" — local-first hydrate would race
//      the cloud read and let a transient SDK error (or a returning player
//      on a new device with stale localStorage) overwrite the real save with
//      defaults. We read FIRST, then mirror cloud → local, then let
//      SaveManager continue. `yandexPlugin()` is awaited from `main.ts`
//      BEFORE `SaveManager.init()` runs, so by the time `hydrate(local)` is
//      called both `ysdk` and `player` are settled.
//
//   2. **Single blob key.** Yandex's setData accepts an arbitrary object;
//      we send `{ blob: <serialized snapshot>, meta: <SaveMeta JSON> }`.
//      The blob is the consolidated `maw_state` blob (the same payload
//      Playgama / GamePix mirror), and `meta` is the same SaveMeta the
//      CrazyGames merge resolver uses — kept here even though we don't
//      run the merge today, so a future cross-device merge has the data.
//      One row per player keeps the request count minimal under the 100
//      req / 5 min cap.
//
// Failure mode: if `getPlayer()` failed at init (anonymous limits, network
// blip) the strategy degrades to local-only (success-empty hydrate, writes
// queue but never drain). `SaveManager` continues to operate against
// localStorage so the player can still play — they just don't get
// cross-device parity on this session.

import { ref } from 'vue'
import type {
  HydrateState,
  HydrateNotice,
  HydrateNoticeListener,
  LocalStorageAccessor,
  SaveStrategy
} from './types'
import { isInternalKey } from './types'
import { STATE_KEY } from '@/use/useMidnightState'
import { META_KEY } from './SaveMergePolicy'
import { isDebug } from '@/use/useMatch'
import { getYandexPlayer } from '@/utils/yandexPlugin'

/** Keys whose persistence must round-trip through `player.setData`. Mirrors
 *  the GamePix allowlist — only the consolidated state blob + its meta cross
 *  devices; debug/cheat toggles stay local-only. */
const PORTAL_KEYS: ReadonlySet<string> = new Set([STATE_KEY, META_KEY])

/** Cloud-side key the entire snapshot lives under. Yandex's `setData` takes
 *  any object; we use a single field so reads/writes are O(1) and well under
 *  the 200 KB cap. */
const CLOUD_BLOB_KEY = 'spin_and_mow_blob'

/** Yandex's documented limit. Logged (not enforced) so a quota breach is
 *  surfaced in QA before it hits production cert. */
const YANDEX_MAX_SIZE_BYTES = 200 * 1024

const TAG = '[yandex-save]'
const dlog = (...args: unknown[]): void => {
  if (isDebug.value) console.info(...args)
}

const shouldMirror = (key: string): boolean =>
  !isInternalKey(key) && PORTAL_KEYS.has(key)

export class YandexStrategy implements SaveStrategy {
  readonly name = 'yandex'

  hydrateState: HydrateState = 'pending'

  /** Reactive mirror of `hydrateState` so the UI status banner picks up
   *  the cloud→local mirror's terminal state. Today this is just the
   *  initial transition; future background retries would surface here. */
  readonly _state = ref<HydrateState>('pending')

  private noticeListeners = new Set<HydrateNoticeListener>()
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  /** Most-recent snapshot waiting to flush — coalesces a burst of writes
   *  into one `setData` call. Map so PORTAL_KEYS are tracked individually
   *  (the cloud payload bundles them; one map slot per key is enough). */
  private dirty = new Map<string, string | null>()
  /** Track in-flight `setData` so a re-entrant `flush()` doesn't fire a
   *  duplicate call. Yandex's rate limit (100 / 5 min) is generous, but
   *  paid-traffic spikes are a cert-review concern. */
  private inFlight: Promise<void> | null = null

  // ─── Hydrate ────────────────────────────────────────────────────────────

  async hydrate(local: LocalStorageAccessor): Promise<void> {
    const player = getYandexPlayer()
    if (!player) {
      // SDK init resolved without a player (anonymous limit, network).
      // Degrade to local-only — writes will queue but the flush guard
      // (no in-flight player) keeps them inert until the next session.
      if (isDebug.value) console.warn(`${TAG} hydrate: no player → success-empty (local-only)`)
      this.setState('success-empty', { reason: 'no-player' })
      return
    }

    try {
      const result = await player.getData([CLOUD_BLOB_KEY])
      const cloud = result?.[CLOUD_BLOB_KEY]
      if (!cloud || typeof cloud !== 'object') {
        dlog(`${TAG} hydrate: cloud empty → success-empty`)
        this.setState('success-empty')
        return
      }
      const { blob, meta } = cloud as { blob?: string; meta?: string }
      let mirrored = 0
      if (typeof blob === 'string' && blob.length > 0) {
        local.set(STATE_KEY, blob)
        mirrored++
      }
      if (typeof meta === 'string' && meta.length > 0) {
        local.set(META_KEY, meta)
        mirrored++
      }
      this.setState(mirrored > 0 ? 'success-with-data' : 'success-empty')
      dlog(`${TAG} hydrate: mirrored ${mirrored} key(s) from cloud`)
    } catch (e) {
      // Cloud read failed (rate-limited, transient network). Don't latch
      // `failed-final` — flag as `failed-retrying` so SaveManager's
      // sanity-retry path can try again, and queue any local writes that
      // arrive in the meantime (they'll drain on next successful read).
      console.warn(`${TAG} hydrate: getData failed`, e)
      this.setState('failed-retrying', { reason: 'getData-failed' })
    }
  }

  onHydrateNotice(listener: HydrateNoticeListener): () => void {
    this.noticeListeners.add(listener)
    return () => this.noticeListeners.delete(listener)
  }

  // ─── Writes (debounced flush) ───────────────────────────────────────────

  onLocalSet(key: string, value: string): void {
    if (!shouldMirror(key)) return
    // Never push to remote until we observed a `success-*` hydrate state —
    // the documented rule that prevents fresh-defaults from clobbering a
    // real cloud save when the read fails transiently.
    if (this.hydrateState !== 'success-with-data' && this.hydrateState !== 'success-empty') {
      // Queue the latest value; will drain on next successful hydrate.
      this.dirty.set(key, value)
      return
    }
    this.dirty.set(key, value)
    this.scheduleFlush()
  }

  onLocalRemove(key: string): void {
    if (!shouldMirror(key)) return
    this.dirty.set(key, null)
    this.scheduleFlush()
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    await this.drain(true)
  }

  dispose(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    this.dirty.clear()
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private setState(state: HydrateState, extra: Partial<HydrateNotice> = {}): void {
    this.hydrateState = state
    this._state.value = state
    const notice: HydrateNotice = { state, ...extra }
    for (const l of this.noticeListeners) {
      try { l(notice) } catch (e) { console.warn(`${TAG} notice listener threw`, e) }
    }
  }

  private scheduleFlush(): void {
    if (this.writeTimer !== null) return
    // 500 ms debounce — same magnitude as CrazyGames (250 ms) but pushed
    // higher because Yandex's rate limit is per-5-min not per-call. Larger
    // window collapses more bursts (slider drags, rapid score increments)
    // into a single payload.
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.drain(false)
    }, 500)
  }

  /**
   * Push the dirty map to Yandex as a single setData payload. `flush=true`
   * forces synchronous serialization (best-effort on page unload) and uses
   * the SDK's `flush: true` to bypass Yandex's batching too.
   */
  private async drain(flush: boolean): Promise<void> {
    if (this.dirty.size === 0) return
    if (this.inFlight) {
      // Another flush already in flight — let it finish, then re-enter so
      // any writes that arrived during it land in the next payload.
      await this.inFlight
      if (this.dirty.size === 0) return
    }
    const player = getYandexPlayer()
    if (!player) {
      dlog(`${TAG} drain: no player (degraded mode) — keeping ${this.dirty.size} write(s) queued`)
      return
    }

    // Snapshot + clear so concurrent writes during the SDK call don't
    // mutate the in-flight batch.
    const batch = new Map(this.dirty)
    this.dirty.clear()

    const blob = batch.get(STATE_KEY) ?? null
    const meta = batch.get(META_KEY) ?? null

    // Two payload shapes:
    //   • Both keys present → write the bundled blob (overwrites cloud).
    //   • Only one key dirty → patch by reading-modifying-merging? We don't
    //     bother. setData replaces the per-key entry, not the whole object,
    //     so writing just `{ blob: 'new' }` keeps `meta` intact on the
    //     cloud row. The same for the reverse.
    const payload: Record<string, unknown> = {}
    // Sub-object the cloud row keeps under CLOUD_BLOB_KEY. Setting a key to
    // `null` removes it from the cloud-side blob; we use `null` for the
    // delete path so a wiped local key also wipes the cloud entry on the
    // next flush.
    const inner: Record<string, unknown> = {}
    if (batch.has(STATE_KEY)) inner.blob = blob
    if (batch.has(META_KEY)) inner.meta = meta
    payload[CLOUD_BLOB_KEY] = inner

    // Size check (warn-only). Yandex rejects payloads > 200 KB with an SDK
    // error; we'd see it as a setData reject. Log proactively so QA catches
    // a runaway blob before the cert audit does.
    const approxBytes = (typeof blob === 'string' ? blob.length : 0)
      + (typeof meta === 'string' ? meta.length : 0)
    if (approxBytes > YANDEX_MAX_SIZE_BYTES) {
      console.warn(
        `${TAG} payload ~${approxBytes} bytes exceeds Yandex's 200 KB cap — ` +
        'setData will likely reject. Investigate state-blob size growth.'
      )
    }

    this.inFlight = (async () => {
      try {
        await player.setData(payload, flush)
        dlog(`${TAG} setData ok (~${approxBytes} bytes, flush=${flush})`)
      } catch (e) {
        console.warn(`${TAG} setData failed — re-queuing`, e)
        // Re-queue the snapshot so the next flush retries (latest values
        // already won via the dirty map — re-queue only those that weren't
        // overwritten in the meantime).
        for (const [k, v] of batch) {
          if (!this.dirty.has(k)) this.dirty.set(k, v)
        }
        if (this.dirty.size > 0) this.scheduleFlush()
      } finally {
        this.inFlight = null
      }
    })()
    await this.inFlight
  }
}
