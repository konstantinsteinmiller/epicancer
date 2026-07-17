// End-to-end scenario tests for the bulletproof-save protocol. Each
// scenario simulates a real-world failure mode that previously cost
// players progress and asserts that the new strategy + manager
// combination handles it without overwriting cloud data.
//
// All scenarios use the CrazyGames SDK shape; the same logic is
// exercised against Glitch in GlitchStrategy.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CrazyGamesStrategy } from '@/utils/save/CrazyGamesStrategy'
import { SaveManager } from '@/utils/save/SaveManager'
import {
  computeMeta,
  META_KEY,
  SAVE_KEYS,
  serializeMeta
} from '@/utils/save/SaveMergePolicy'

const KEYS_MANIFEST = '__save_internal__crazy_keys'

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

/** Build the SDK store contents for a returning player at stage N with
 *  a handful of nights survived. Per-key shape — one entry per gameplay
 *  value plus the manifest. */
const seedReturningPlayer = (bestScore: number, nights: number) => {
  const meta = serializeMeta(computeMeta(
    {
      get: (k: string) => {
        if (k === SAVE_KEYS.BEST_SCORE) return String(bestScore)
        if (k === SAVE_KEYS.NIGHTS) return String(nights)
        return null
      }
    },
    '2026-04-26T10:00:00Z'
  ))
  return {
    [KEYS_MANIFEST]: JSON.stringify([SAVE_KEYS.BEST_SCORE, SAVE_KEYS.NIGHTS, META_KEY]),
    [SAVE_KEYS.BEST_SCORE]: String(bestScore),
    [SAVE_KEYS.NIGHTS]: String(nights),
    [META_KEY]: meta
  }
}

describe('Bulletproof save scenarios', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('Scenario 1: returning player — clean hydrate, no boot retries', async () => {
    const data = makeFakeData(seedReturningPlayer(6, 720))
    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    await manager.init()

    expect(window.localStorage.getItem(SAVE_KEYS.BEST_SCORE)).toBe('6')
    expect(window.localStorage.getItem(SAVE_KEYS.NIGHTS)).toBe('720')
    expect(manager.hydrateState).toBe('success-with-data')
    expect(data.getItem.mock.calls.filter(c => c[0] === KEYS_MANIFEST)).toHaveLength(1)
  })

  it('Scenario 2: returning player + transient SDK error — sanity-guard retry recovers', async () => {
    const seed = seedReturningPlayer(6, 720)
    const data = makeFakeData(seed)
    let calls = 0
    data.getItem.mockImplementation(async (key: string) => {
      calls++
      if (key === KEYS_MANIFEST && calls === 1) throw new Error('transient SDK error')
      return seed[key as keyof typeof seed] ?? null
    })

    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    const initPromise = manager.init()
    await vi.advanceTimersByTimeAsync(1_500)
    await initPromise

    expect(manager.hydrateState).toBe('success-with-data')
    expect(window.localStorage.getItem(SAVE_KEYS.BEST_SCORE)).toBe('6')
    expect(window.localStorage.getItem(SAVE_KEYS.NIGHTS)).toBe('720')
  })

  it('Scenario 3: returning player + persistent failure — local writes do NOT flush to remote', async () => {
    const data = makeFakeData(seedReturningPlayer(6, 720))
    data.getItem.mockImplementation(async () => {
      throw new Error('persistent failure')
    })

    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    const initPromise = manager.init()
    await vi.advanceTimersByTimeAsync(5_000)
    await initPromise

    expect(manager.hydrateState).toBe('failed-retrying')

    window.localStorage.setItem(SAVE_KEYS.BEST_SCORE, '1')
    window.localStorage.setItem(SAVE_KEYS.NIGHTS, '0')
    await vi.advanceTimersByTimeAsync(2_000)

    const remoteWrites = data.setItem.mock.calls
    expect(remoteWrites).toHaveLength(0)
  })

  it('Scenario 4: new player — empty remote confirmed, local seeds remote', async () => {
    const data = makeFakeData()
    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    const initPromise = manager.init()
    await vi.runAllTimersAsync()
    await initPromise

    expect(manager.hydrateState).toBe('success-empty')

    window.localStorage.setItem(SAVE_KEYS.BEST_SCORE, '2')
    window.localStorage.setItem(SAVE_KEYS.NIGHTS, '50')
    await vi.runAllTimersAsync()

    expect(data.store.get(SAVE_KEYS.BEST_SCORE)).toBe('2')
    expect(data.store.get(SAVE_KEYS.NIGHTS)).toBe('50')
    expect(data.store.get(META_KEY)).toBeTruthy()
  })

  it('Scenario 5: local ahead of remote — local wins, pushed to remote', async () => {
    const data = makeFakeData(seedReturningPlayer(4, 200))

    window.localStorage.setItem(SAVE_KEYS.BEST_SCORE, '5')
    window.localStorage.setItem(SAVE_KEYS.NIGHTS, '300')
    window.localStorage.setItem(META_KEY, serializeMeta(computeMeta(
      { get: (k) => window.localStorage.getItem(k) },
      '2026-04-27T10:00:00Z'
    )))

    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    await manager.init()
    await vi.runAllTimersAsync()

    expect(window.localStorage.getItem(SAVE_KEYS.BEST_SCORE)).toBe('5')
    expect(window.localStorage.getItem(SAVE_KEYS.NIGHTS)).toBe('300')
    expect(data.store.get(SAVE_KEYS.BEST_SCORE)).toBe('5')
    expect(data.store.get(SAVE_KEYS.NIGHTS)).toBe('300')
  })

  it('Scenario 6: remote ahead of local — remote wins, NO bonus on CG', async () => {
    const data = makeFakeData(seedReturningPlayer(10, 500))

    window.localStorage.setItem(SAVE_KEYS.BEST_SCORE, '3')
    window.localStorage.setItem(SAVE_KEYS.NIGHTS, '100')
    window.localStorage.setItem(META_KEY, serializeMeta(computeMeta(
      { get: (k) => window.localStorage.getItem(k) },
      '2026-04-27T08:00:00Z'
    )))

    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    await manager.init()
    await vi.runAllTimersAsync()

    expect(window.localStorage.getItem(SAVE_KEYS.BEST_SCORE)).toBe('10')
    expect(window.localStorage.getItem(SAVE_KEYS.NIGHTS)).toBe('500')
    expect(data.store.get(SAVE_KEYS.NIGHTS)).toBe('500')
  })

  it('Scenario 7: identical local + remote — tie-keep-local, no re-upload', async () => {
    const meta = computeMeta(
      { get: (k) => k === SAVE_KEYS.BEST_SCORE ? '5' : k === SAVE_KEYS.NIGHTS ? '250' : null },
      '2026-04-27T10:00:00Z'
    )
    const seed = {
      [KEYS_MANIFEST]: JSON.stringify([SAVE_KEYS.BEST_SCORE, SAVE_KEYS.NIGHTS, META_KEY]),
      [SAVE_KEYS.BEST_SCORE]: '5',
      [SAVE_KEYS.NIGHTS]: '250',
      [META_KEY]: serializeMeta(meta)
    }
    const data = makeFakeData(seed)

    window.localStorage.setItem(SAVE_KEYS.BEST_SCORE, '5')
    window.localStorage.setItem(SAVE_KEYS.NIGHTS, '250')
    window.localStorage.setItem(META_KEY, serializeMeta(meta))

    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    await manager.init()
    await vi.runAllTimersAsync()

    const realWrites = data.setItem.mock.calls.filter(c => c[0] !== KEYS_MANIFEST)
    expect(realWrites).toHaveLength(0)
  })

  it('Scenario 8 (regression test): hydrate failure + module defaults must NOT overwrite remote', async () => {
    const seed = seedReturningPlayer(6, 720)
    const data = makeFakeData(seed)
    data.getItem.mockImplementation(async () => {
      throw new Error('blip')
    })

    const manager = new SaveManager(new CrazyGamesStrategy(() => data))
    const initPromise = manager.init()
    await vi.advanceTimersByTimeAsync(5_000)
    await initPromise

    window.localStorage.setItem(SAVE_KEYS.BEST_SCORE, '1')
    window.localStorage.setItem(SAVE_KEYS.NIGHTS, '0')
    window.localStorage.setItem(SAVE_KEYS.BOSSES, JSON.stringify({ tops: {}, bottoms: {} }))
    await vi.advanceTimersByTimeAsync(2_000)

    expect(data.store.get(SAVE_KEYS.BEST_SCORE)).toBe('6')
    expect(data.store.get(SAVE_KEYS.NIGHTS)).toBe('720')
  })
})
