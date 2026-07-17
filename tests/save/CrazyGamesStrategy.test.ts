import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CrazyGamesStrategy } from '@/utils/save/CrazyGamesStrategy'
import { SaveManager } from '@/utils/save/SaveManager'
import { SAVE_KEYS, META_KEY } from '@/utils/save/SaveMergePolicy'

// Fake CrazyGames `data` module — keeps an in-memory map so we can assert
// on what got mirrored. The real SDK API is a subset we can fully cover
// here (`getItem` / `setItem` / `removeItem`).
const makeFakeData = (seed: Record<string, string> = {}) => {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    store,
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key)
    })
  }
}

const MANIFEST_KEY = '__save_internal__crazy_keys'

const initWithFakeTimers = async (manager: SaveManager) => {
  const p = manager.init()
  await vi.runAllTimersAsync()
  await p
}

describe('CrazyGamesStrategy (per-key)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('hydrates localStorage from the SDK manifest at boot', async () => {
    const data = makeFakeData({
      [MANIFEST_KEY]: JSON.stringify([SAVE_KEYS.NIGHTS, SAVE_KEYS.BEST_SCORE]),
      [SAVE_KEYS.NIGHTS]: '150',
      [SAVE_KEYS.BEST_SCORE]: '3'
    })
    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    await initWithFakeTimers(manager)

    expect(window.localStorage.getItem(SAVE_KEYS.NIGHTS)).toBe('150')
    expect(window.localStorage.getItem(SAVE_KEYS.BEST_SCORE)).toBe('3')
  })

  it('mirrors subsequent writes to the SDK after a debounce, sorted', async () => {
    const data = makeFakeData()
    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    await initWithFakeTimers(manager)

    window.localStorage.setItem(SAVE_KEYS.BEST_SCORE, '2')
    window.localStorage.setItem(SAVE_KEYS.NIGHTS, '20')

    expect(data.setItem).not.toHaveBeenCalled()

    await vi.runAllTimersAsync()

    // Per-key writes plus the manifest. Verify both gameplay values landed.
    const writes = data.setItem.mock.calls.filter(c => c[0] !== MANIFEST_KEY)
    expect(writes).toContainEqual([SAVE_KEYS.NIGHTS, '20'])
    expect(writes).toContainEqual([SAVE_KEYS.BEST_SCORE, '2'])

    // Wire ordering is sorted alphabetically.
    const orderedKeys = writes.map(c => c[0])
    expect(orderedKeys).toEqual([...orderedKeys].sort())

    // Manifest carries the full sorted key list.
    const manifest = JSON.parse(data.store.get(MANIFEST_KEY)!)
    expect(manifest).toContain(SAVE_KEYS.NIGHTS)
    expect(manifest).toContain(SAVE_KEYS.BEST_SCORE)
  })

  it('does NOT mirror non-allowlisted keys (vConsole / ad-tech / dev flags)', async () => {
    const data = makeFakeData()
    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    await initWithFakeTimers(manager)

    window.localStorage.setItem(SAVE_KEYS.NIGHTS, '99')
    window.localStorage.setItem('vConsole_switch_x', '0')
    window.localStorage.setItem('prebid11_exp_1_26', 'false')
    window.localStorage.setItem('li-module-enabled', 'true')

    await vi.runAllTimersAsync()

    const writes = data.setItem.mock.calls.map(c => c[0])
    expect(writes).toContain(SAVE_KEYS.NIGHTS)
    expect(writes).not.toContain('vConsole_switch_x')
    expect(writes).not.toContain('prebid11_exp_1_26')
    expect(writes).not.toContain('li-module-enabled')
  })

  it('mirrors removeItem to the SDK and drops the key from the manifest', async () => {
    const data = makeFakeData({
      [MANIFEST_KEY]: JSON.stringify([SAVE_KEYS.NIGHTS]),
      [SAVE_KEYS.NIGHTS]: '5'
    })
    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    await initWithFakeTimers(manager)

    window.localStorage.removeItem(SAVE_KEYS.NIGHTS)
    await vi.runAllTimersAsync()

    expect(data.removeItem).toHaveBeenCalledWith(SAVE_KEYS.NIGHTS)
    expect(JSON.parse(data.store.get(MANIFEST_KEY)!)).not.toContain(SAVE_KEYS.NIGHTS)
  })

  it('no-ops gracefully when the SDK is unavailable', async () => {
    const manager = new SaveManager(new CrazyGamesStrategy(() => null))
    await initWithFakeTimers(manager)

    expect(() => window.localStorage.setItem(SAVE_KEYS.NIGHTS, '1')).not.toThrow()
    await vi.runAllTimersAsync()
    expect(window.localStorage.getItem(SAVE_KEYS.NIGHTS)).toBe('1')
  })

  it('flush() pushes pending writes synchronously on demand', async () => {
    const data = makeFakeData()
    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    await initWithFakeTimers(manager)

    window.localStorage.setItem(SAVE_KEYS.NIGHTS, '1')
    expect(data.setItem).not.toHaveBeenCalled()

    await manager.flush()

    expect(data.setItem).toHaveBeenCalledWith(SAVE_KEYS.NIGHTS, '1')
  })

  it('does not mirror hydration writes back to the SDK', async () => {
    const data = makeFakeData({
      [MANIFEST_KEY]: JSON.stringify([SAVE_KEYS.NIGHTS]),
      [SAVE_KEYS.NIGHTS]: '150'
    })
    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    await initWithFakeTimers(manager)

    expect(data.setItem).not.toHaveBeenCalled()
  })

  it('META blob rides along with each flush so the next hydrate can merge', async () => {
    const data = makeFakeData()
    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    await initWithFakeTimers(manager)

    window.localStorage.setItem(SAVE_KEYS.BEST_SCORE, '4')
    await vi.runAllTimersAsync()

    expect(data.store.get(META_KEY)).toBeTruthy()
    const meta = JSON.parse(data.store.get(META_KEY)!)
    expect(meta.savedAt).toBeTruthy()
    expect(meta.maxStage).toBe(4)
  })

  // ─── Settings-stranding regression ──────────────────────────────────────
  // Background: useUser.ts holds language / difficulty / sound-volume /
  // music-volume in module-level Vue refs. The composable only writes a
  // value to localStorage when the player explicitly opens OptionsModal
  // and changes it via setSettingValue(). A player who never touches
  // settings produces zero localStorage writes for those keys, so the
  // strategy's onLocalSet path never fires and the cloud ends up without
  // them. To round-trip correctly the strategy MUST sweep local payload
  // keys after the merge resolution and queue any value missing from
  // sdk.data.

  it('pushes settings keys present in local but missing from sdk.data', async () => {
    // Simulates useUser.ts having seeded its current ref values into
    // localStorage just before the strategy runs (the `useUser` side
    // of the fix). Cloud is empty.
    window.localStorage.setItem('spinner_user_sound_volume', '0.7')
    window.localStorage.setItem('spinner_user_music_volume', '0.6')
    window.localStorage.setItem('spinner_user_language', 'en')
    window.localStorage.setItem('spinner_user_difficulty', 'medium')

    const data = makeFakeData()
    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    await initWithFakeTimers(manager)

    // Every settings key reaches sdk.data after init resolves.
    expect(data.setItem).toHaveBeenCalledWith('spinner_user_sound_volume', '0.7')
    expect(data.setItem).toHaveBeenCalledWith('spinner_user_music_volume', '0.6')
    expect(data.setItem).toHaveBeenCalledWith('spinner_user_language', 'en')
    expect(data.setItem).toHaveBeenCalledWith('spinner_user_difficulty', 'medium')

    // Manifest carries every settings key — next refresh's hydrate
    // fast-path will read them back without needing recovery.
    const manifest = JSON.parse(data.store.get(MANIFEST_KEY)!)
    expect(manifest).toContain('spinner_user_sound_volume')
    expect(manifest).toContain('spinner_user_music_volume')
    expect(manifest).toContain('spinner_user_language')
    expect(manifest).toContain('spinner_user_difficulty')
  })

  it('does NOT re-push settings keys that already match sdk.data', async () => {
    // Player previously synced — both sides agree on every key. The
    // post-hydrate sweep should dedupe via lastSentByKey and skip a
    // redundant flush so QA doesn't see spurious writes on every load.
    window.localStorage.setItem('spinner_user_language', 'es')

    const data = makeFakeData({
      [MANIFEST_KEY]: JSON.stringify(['spinner_user_language']),
      'spinner_user_language': 'es'
    })
    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    await initWithFakeTimers(manager)

    expect(data.setItem).not.toHaveBeenCalled()
  })

  it('on a fresh-remote hydrate, seeds sdk.data with every local payload key', async () => {
    // Cloud is fresh (no manifest). Local has full gameplay state from
    // the last session AND user settings. Every local payload key must
    // reach sdk.data so the player's first cloud save is complete.
    window.localStorage.setItem(SAVE_KEYS.BEST_SCORE, '5')
    window.localStorage.setItem(SAVE_KEYS.NIGHTS, '300')
    window.localStorage.setItem('spinner_user_language', 'fr')

    const data = makeFakeData()
    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    await initWithFakeTimers(manager)

    expect(data.setItem).toHaveBeenCalledWith(SAVE_KEYS.BEST_SCORE, '5')
    expect(data.setItem).toHaveBeenCalledWith(SAVE_KEYS.NIGHTS, '300')
    expect(data.setItem).toHaveBeenCalledWith('spinner_user_language', 'fr')
  })

  // ─── Cloud-only mode (CG QA requirement) ────────────────────────────────
  // Requirement: on CrazyGames builds, gameplay state ("spinner_*", "ca_*")
  // and our save bookkeeping ("__save_internal__*", "__save_meta__") MUST
  // NOT live in raw localStorage. Only "fps", "debug", "cheat",
  // "campaign-test", "full_unlocked" (developer toggles touched from
  // DevTools) are exempt. Persistence is sdk.data only; localStorage is
  // a runtime cache served from BlobStorage's in-memory map.

  it('cloud-only mode: payload writes never land in raw localStorage', async () => {
    // Capture un-patched accessor BEFORE SaveManager replaces it on the
    // window.localStorage instance — test setup uses an in-memory
    // polyfill, so we read via the prototype to bypass the patched proxy.
    const proto = Object.getPrototypeOf(window.localStorage)
    const rawGet = proto.getItem.bind(window.localStorage)

    const data = makeFakeData()
    const manager = new SaveManager(
      new CrazyGamesStrategy(() => data),
      window.localStorage,
      { blob: { persistToRaw: false } }
    )
    await initWithFakeTimers(manager)

    window.localStorage.setItem(SAVE_KEYS.BEST_SCORE, '7')
    window.localStorage.setItem(SAVE_KEYS.NIGHTS, '500')
    window.localStorage.setItem('spinner_user_sound_volume', '0.4')
    await vi.runAllTimersAsync()

    // sdk.data has the values.
    expect(data.store.get(SAVE_KEYS.BEST_SCORE)).toBe('7')
    expect(data.store.get(SAVE_KEYS.NIGHTS)).toBe('500')
    expect(data.store.get('spinner_user_sound_volume')).toBe('0.4')

    // Raw localStorage is empty of every gameplay + bookkeeping key.
    expect(rawGet(SAVE_KEYS.BEST_SCORE)).toBeNull()
    expect(rawGet(SAVE_KEYS.NIGHTS)).toBeNull()
    expect(rawGet('spinner_user_sound_volume')).toBeNull()
    expect(rawGet(MANIFEST_KEY)).toBeNull()
    expect(rawGet(META_KEY)).toBeNull()
  })

  it('cloud-only mode: dev toggles ARE preserved in raw localStorage', async () => {
    const proto = Object.getPrototypeOf(window.localStorage)
    const rawGet = proto.getItem.bind(window.localStorage)

    // Dev toggles set before SaveManager constructs.
    window.localStorage.setItem('fps', 'true')
    window.localStorage.setItem('debug', 'true')
    window.localStorage.setItem('cheat', 'true')
    window.localStorage.setItem('campaign-test', '1')
    window.localStorage.setItem('full_unlocked', 'true')

    const data = makeFakeData()
    const manager = new SaveManager(
      new CrazyGamesStrategy(() => data),
      window.localStorage,
      { blob: { persistToRaw: false } }
    )
    await initWithFakeTimers(manager)

    expect(rawGet('fps')).toBe('true')
    expect(rawGet('debug')).toBe('true')
    expect(rawGet('cheat')).toBe('true')
    expect(rawGet('campaign-test')).toBe('1')
    expect(rawGet('full_unlocked')).toBe('true')

    // And subsequent writes to dev toggles still land in raw.
    window.localStorage.setItem('debug', 'false')
    expect(rawGet('debug')).toBe('false')
  })

  it('cloud-only mode: scrubs pre-existing payload + bookkeeping at boot, preserves dev toggles', async () => {
    // Simulates upgrading a returning player from per-key-raw-mirror
    // mode to cloud-only mode: their localStorage already has spinner_*
    // entries, the META blob, and the manifest. After construction
    // every gameplay/bookkeeping key must be gone from raw, but the
    // values must survive in BlobStorage's in-memory state so the
    // hydrate's local meta still computes from real values.
    window.localStorage.setItem(SAVE_KEYS.BEST_SCORE, '6')
    window.localStorage.setItem(SAVE_KEYS.NIGHTS, '8818')
    window.localStorage.setItem('spinner_user_sound_volume', '0.7')
    window.localStorage.setItem(META_KEY, JSON.stringify({
      savedAt: '2025-01-01T00:00:00.000Z',
      progressScore: 3000,
      schemaVersion: 1,
      maxStage: 6
    }))
    window.localStorage.setItem(MANIFEST_KEY, JSON.stringify([SAVE_KEYS.BEST_SCORE, SAVE_KEYS.NIGHTS, 'spinner_user_sound_volume']))
    window.localStorage.setItem('fps', 'true')

    const proto = Object.getPrototypeOf(window.localStorage)
    const rawGet = proto.getItem.bind(window.localStorage)

    const data = makeFakeData()
    const manager = new SaveManager(
      new CrazyGamesStrategy(() => data),
      window.localStorage,
      { blob: { persistToRaw: false } }
    )
    await initWithFakeTimers(manager)

    // Raw is scrubbed of all payload + bookkeeping keys.
    expect(rawGet(SAVE_KEYS.BEST_SCORE)).toBeNull()
    expect(rawGet(SAVE_KEYS.NIGHTS)).toBeNull()
    expect(rawGet('spinner_user_sound_volume')).toBeNull()
    expect(rawGet(META_KEY)).toBeNull()
    expect(rawGet(MANIFEST_KEY)).toBeNull()
    // Dev toggle preserved.
    expect(rawGet('fps')).toBe('true')

    // Values readable via the patched accessor (in-memory state),
    // and forwarded to sdk.data on the next flush.
    expect(window.localStorage.getItem(SAVE_KEYS.BEST_SCORE)).toBe('6')
    expect(window.localStorage.getItem(SAVE_KEYS.NIGHTS)).toBe('8818')
    expect(window.localStorage.getItem('spinner_user_sound_volume')).toBe('0.7')
    expect(data.store.get(SAVE_KEYS.BEST_SCORE)).toBe('6')
    expect(data.store.get('spinner_user_sound_volume')).toBe('0.7')
  })

  it('cloud-only mode: saveDataVersion bumps AFTER patchLocalStorage, not during hydrate', async () => {
    // Regression for the timing bug: composables (useUser, useSpinnerCampaign,
    // etc.) watch `saveDataVersion` and re-read localStorage when it bumps.
    // If the bump fires DURING hydrate, the watcher runs before
    // `patchLocalStorage()` installs the BlobStorage proxy — every read
    // hits raw localStorage (empty in cloud-only mode after the boot
    // scrub) and every write lands in raw too. The fix bumps
    // `saveDataVersion` from `SaveManager.init()` AFTER patches.
    //
    // We assert via a synthetic listener that captures the value of
    // `manager.isHydrated()` at the moment the version bump arrives.
    // It must be `true` — i.e. patching has finished.
    const data = makeFakeData({
      [MANIFEST_KEY]: JSON.stringify([SAVE_KEYS.BEST_SCORE]),
      [SAVE_KEYS.BEST_SCORE]: '6'
    })
    const manager = new SaveManager(
      new CrazyGamesStrategy(() => data),
      window.localStorage,
      { blob: { persistToRaw: false } }
    )

    let observedHydratedAtBump: boolean | null = null
    manager.onBootComplete(() => {
      observedHydratedAtBump = manager.isHydrated()
    })

    await initWithFakeTimers(manager)

    expect(observedHydratedAtBump).toBe(true)
  })

  it('cloud-only mode: a write after refresh does NOT shrink the cloud manifest', async () => {
    // Regression for the manifest-overwrite bug: in cloud-only mode the
    // manifest lives in BlobStorage's internalShadow. On a fresh page
    // load the shadow is empty until hydrate syncs the cloud manifest
    // into it. Without that sync, `trackKey` reads `[]`, the first
    // write produces a single-key manifest, and `doFlush` uploads it,
    // orphaning every other key on sdk.data.
    const cloudKeys = [
      SAVE_KEYS.BEST_SCORE,
      SAVE_KEYS.NIGHTS,
      'spinner_user_language',
      META_KEY
    ]
    const data = makeFakeData({
      [MANIFEST_KEY]: JSON.stringify(cloudKeys),
      [SAVE_KEYS.BEST_SCORE]: '6',
      [SAVE_KEYS.NIGHTS]: '8818',
      'spinner_user_language': 'es',
      [META_KEY]: JSON.stringify({
        savedAt: '2025-01-01T00:00:00.000Z',
        progressScore: 3000,
        schemaVersion: 1,
        maxStage: 6
      })
    })
    const manager = new SaveManager(
      new CrazyGamesStrategy(() => data),
      window.localStorage,
      { blob: { persistToRaw: false } }
    )
    await initWithFakeTimers(manager)

    // Player switches language to French.
    window.localStorage.setItem('spinner_user_language', 'fr')
    await vi.runAllTimersAsync()

    // Cloud still has every key — none orphaned.
    expect(data.store.get(SAVE_KEYS.BEST_SCORE)).toBe('6')
    expect(data.store.get(SAVE_KEYS.NIGHTS)).toBe('8818')
    expect(data.store.get('spinner_user_language')).toBe('fr')

    // Manifest still lists every cloud key plus META.
    const manifest = JSON.parse(data.store.get(MANIFEST_KEY)!)
    expect(manifest).toContain(SAVE_KEYS.BEST_SCORE)
    expect(manifest).toContain(SAVE_KEYS.NIGHTS)
    expect(manifest).toContain('spinner_user_language')
    expect(manifest).toContain(META_KEY)
  })
})
