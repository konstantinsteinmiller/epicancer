import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

// ─── Cloud → composable hydrate (CrazyGames cloud-only mode) ────────────────
//
// Proves the load-side wiring: the whole game state lives in the single
// `midnight_state` blob (an allowlisted payload key), so the
// CrazyGamesStrategy mirrors it verbatim to `sdk.data`. On boot,
// `reloadMidnightState()` is wired into the `saveDataVersion` bump inside
// useSaveStatus, so every `watch(saveDataVersion)` consumer (coins, stage,
// upgrades, battle pass) sees the freshly-hydrated blob instead of the empty
// pre-hydrate snapshot.

const MANIFEST_KEY = '__save_internal__crazy_keys'
const STATE_KEY = 'midnight_state'

const makeFakeData = (seed: Record<string, string> = {}) => {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    store,
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
    removeItem: vi.fn(async (key: string) => { store.delete(key) })
  }
}

const flush = async () => { await nextTick(); await nextTick() }

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

/** A CG-cloud snapshot whose `midnight_state` blob carries a full set of
 *  persisted properties, plus the meta blob the merge resolver needs to pick
 *  remote over an empty local. */
const seededCloud = async () => {
  const { META_KEY } = await import('@/utils/save/SaveMergePolicy')
  const cloudBlob = {
    ma_best_score: 14,
    ma_nights_survived: 9,
    ma_bosses_cleared: 2,
    ma_ideas_played: 63,
    ma_game_stats: { router: { wins: 8, plays: 12 } },
    spinner_user_sound_volume: 0.4
  }
  const meta = {
    savedAt: '2026-05-19T00:00:00.000Z',
    progressScore: 14 * 500 + 9 * 150 + 2 * 400,
    schemaVersion: 1,
    maxStage: 14
  }
  return makeFakeData({
    [MANIFEST_KEY]: JSON.stringify([STATE_KEY, META_KEY]),
    [STATE_KEY]: JSON.stringify(cloudBlob),
    [META_KEY]: JSON.stringify(meta)
  })
}

const bootCloudOnly = async (data: ReturnType<typeof makeFakeData>) => {
  const { SaveManager } = await import('@/utils/save/SaveManager')
  const { CrazyGamesStrategy } = await import('@/utils/save/CrazyGamesStrategy')
  const { installSaveStatus } = await import('@/use/useSaveStatus')
  const manager = new SaveManager(
    new CrazyGamesStrategy(() => data),
    window.localStorage,
    { blob: { persistToRaw: false } }
  )
  installSaveStatus(manager)
  await manager.init()
  await flush()
  return manager
}

describe('midnight_state cloud hydrate → composable refresh', () => {
  it('loads the cloud record into useMidnightProgress after boot', async () => {
    const prog = await import('@/use/useMidnightProgress')
    // Pre-hydrate: the composable evaluated against an empty blob.
    expect(prog.bestScore.value).toBe(0)

    await bootCloudOnly(await seededCloud())

    expect(prog.bestScore.value).toBe(14)
    expect(prog.nightsSurvived.value).toBe(9)
    expect(prog.bossesCleared.value).toBe(2)
  })

  it('refreshes every blob-backed property from the cloud', async () => {
    const prog = await import('@/use/useMidnightProgress')

    await bootCloudOnly(await seededCloud())

    expect(prog.ideasPlayed.value).toBe(63)
    expect(prog.gameStats.value.router).toEqual({ wins: 8, plays: 12 })
  })

  it('refreshes refs on a post-boot recovery hydrate (background retry path)', async () => {
    const prog = await import('@/use/useMidnightProgress')
    const data = makeFakeData()
    const manager = await bootCloudOnly(data)
    expect(prog.bestScore.value).toBe(0)

    const seeded = await seededCloud()
    for (const [k, v] of seeded.store) data.store.set(k, v)

    await manager.retryHydrate()
    await flush()

    expect(prog.bestScore.value).toBe(14)
  })
})

describe('midnight_state persistence round-trip (write → sdk.data)', () => {
  it('mirrors the whole blob to sdk.data and restores it on a fresh boot', async () => {
    const data = makeFakeData()
    const manager = await bootCloudOnly(data)

    const blob = {
      ma_best_score: 21,
      ma_nights_survived: 3,
      ma_bosses_cleared: 1
    }
    window.localStorage.setItem(STATE_KEY, JSON.stringify(blob))

    await manager.flush()

    expect(data.store.get(STATE_KEY)).toBe(JSON.stringify(blob))
    const manifest = JSON.parse(data.store.get(MANIFEST_KEY)!)
    expect(manifest).toContain(STATE_KEY)

    // Round-trips: a fresh boot over the same cloud restores the record.
    vi.resetModules()
    localStorage.clear()
    const prog = await import('@/use/useMidnightProgress')
    await bootCloudOnly(data)
    expect(prog.bestScore.value).toBe(21)
    expect(prog.bossesCleared.value).toBe(1)
  })
})
