import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── flushSaveNow — immediate checkpoint flush (the CG "stage lost on reload"
// regression) ──────────────────────────────────────────────────────────────
//
// On the CrazyGames cloud-only build, finishing a night writes the new record
// into `midnight_state` but the push to `sdk.data` only fires after the persist
// (~200ms) + strategy-flush (~250ms) debounces, and the async cloud write then
// takes time to land. A player who survives a personal best and reloads a
// moment later beat that pipeline → reload restored the OLD record.
//
// `flushSaveNow()` (called at hard checkpoints) forces the whole pipeline to
// drain synchronously-as-possible: write `midnight_state` now → SaveManager
// proxy → strategy dirty → `manager.flush()` → backend. This test proves a
// write reaches the (fake) backend right after `flushSaveNow()` WITHOUT
// advancing any timers — i.e. it does not wait for either debounce.

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
  return manager
}

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

describe('flushSaveNow — immediate flush on a hard checkpoint', () => {
  it('pushes a pending stage write to the backend without waiting for the debounce', async () => {
    const data = makeFakeData()
    await bootCloudOnly(data)

    const { setState } = await import('@/use/useMidnightState')
    const { flushSaveNow } = await import('@/use/useSaveStatus')

    // A level change writes the new stage into maw_state (still on the debounce
    // timers — nothing has reached the cloud yet).
    setState('spinner_campaign_stage', 2)
    expect(data.store.get(STATE_KEY)).toBeUndefined()

    // The checkpoint flush drains everything immediately — no fake timers.
    await flushSaveNow()

    const cloudBlob = JSON.parse(data.store.get(STATE_KEY) || '{}')
    expect(cloudBlob.spinner_campaign_stage).toBe(2)
  })

  it('also carries coexisting progress (coins) written in the same checkpoint', async () => {
    const data = makeFakeData()
    await bootCloudOnly(data)

    const { setState } = await import('@/use/useMidnightState')
    const { flushSaveNow } = await import('@/use/useSaveStatus')

    setState('spinner_coins', 250)
    setState('spinner_campaign_stage', 3)
    await flushSaveNow()

    const cloudBlob = JSON.parse(data.store.get(STATE_KEY) || '{}')
    expect(cloudBlob.spinner_campaign_stage).toBe(3)
    expect(cloudBlob.spinner_coins).toBe(250)
  })
})

// A short tick that lets a fire-and-forget `void flushSaveNow()` async chain
// settle WITHOUT advancing far enough to trip the 200ms persist debounce — so
// anything in the cloud after it got there via the immediate checkpoint flush,
// not the throttle.
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('discrete progression events flush to the backend immediately', () => {
  it('surviving a personal-best night flushes without waiting for the debounce', async () => {
    const data = makeFakeData()
    await bootCloudOnly(data)
    const { recordNightEnd } = await import('@/use/useMidnightProgress')
    const { flushSaveNow } = await import('@/use/useSaveStatus')

    expect(recordNightEnd(12)).toBe(true) // 12 > the fresh-default 0 → new best
    await flushSaveNow()
    await settle()

    const blob = JSON.parse(data.store.get(STATE_KEY) || '{}')
    expect(blob.ma_best_score).toBe(12)
    expect(blob.ma_nights_survived).toBe(1)
  })

  it('a sub-record night still banks the nights-survived counter', async () => {
    const data = makeFakeData()
    await bootCloudOnly(data)
    const { recordNightEnd } = await import('@/use/useMidnightProgress')
    const { flushSaveNow } = await import('@/use/useSaveStatus')

    recordNightEnd(9)
    expect(recordNightEnd(4)).toBe(false) // 4 < 9 → record untouched
    await flushSaveNow()
    await settle()

    const blob = JSON.parse(data.store.get(STATE_KEY) || '{}')
    expect(blob.ma_best_score).toBe(9)
    expect(blob.ma_nights_survived).toBe(2)
  })

  it('a per-micro-game tally does NOT flush immediately — it stays throttled', async () => {
    const data = makeFakeData()
    await bootCloudOnly(data)
    const { recordGameResult } = await import('@/use/useMidnightProgress')
    const { flushSaveNow } = await import('@/use/useSaveStatus')

    recordGameResult('router', true)
    await settle()
    // Still on the throttle — nothing reached the cloud within a tick.
    expect(data.store.get(STATE_KEY)).toBeUndefined()

    // …but a later checkpoint (or the next discrete event) carries it.
    await flushSaveNow()
    const blob = JSON.parse(data.store.get(STATE_KEY) || '{}')
    expect(blob.ma_game_stats?.router).toEqual({ wins: 1, plays: 1 })
    expect(blob.ma_ideas_played).toBe(1)
  })
})

describe('per-round persist throttle — 2.5s max-wait', () => {
  it('forces a localStorage write within ~2.5s of a continuous change stream', async () => {
    vi.useFakeTimers()
    try {
      const { setState } = await import('@/use/useMidnightState')
      // A run's score ticks faster than the 200ms trailing debounce, so a pure
      // debounce would never fire. The max-wait must force a write by 2.5s.
      for (let t = 100; t <= 2000; t += 100) {
        setState('ma_ideas_played', t)
        vi.advanceTimersByTime(100)
      }
      expect(window.localStorage.getItem(STATE_KEY)).toBeNull() // not yet (under 2.5s)

      setState('ma_ideas_played', 2100)
      vi.advanceTimersByTime(600) // cross the 2.5s cap
      expect(window.localStorage.getItem(STATE_KEY)).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
