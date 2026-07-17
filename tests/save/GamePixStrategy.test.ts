// Regression coverage for the GamePix "state resets on every reload" bug.
//
// Root cause: the GamePix v3 SDK exposes `window.GamePix.localStorage` whose
// OBJECT appears as soon as `sdk.init()` resolves, but whose player DATA loads
// asynchronously a beat later. The old `hydrate` read STATE_KEY once right
// after the object appeared, saw `null`, and latched `success-empty` — so the
// game booted at defaults and then overwrote the portal save with those
// defaults. On localhost the raw-localStorage seed masked it (native storage
// persists); inside the GamePix toolkit iframe native storage is ephemeral, so
// every reload reset to stage 1 / 0 coins.
//
// The fix polls the portal store for the STATE blob (not just the object's
// existence) up to a timeout before concluding the player is new.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GamePixStrategy } from '@/utils/save/GamePixStrategy'

const STATE_KEY = 'midnight_state'

interface FakeLocal {
  get: (k: string) => string | null
  set: (k: string, v: string) => void
  remove: (k: string) => void
  keys: () => string[]
}

const makeLocal = (): FakeLocal & { map: Map<string, string> } => {
  const map = new Map<string, string>()
  return {
    map,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => { map.set(k, v) },
    remove: (k) => { map.delete(k) },
    keys: () => [...map.keys()]
  }
}

/** Install a fake `window.GamePix.localStorage` whose data only becomes
 *  readable `readyAfterMs` into the test — simulating the SDK's async data
 *  load. Uses the faked clock so tests stay instant. */
const installFakePortal = (opts: { seed?: Record<string, string>; readyAfterMs?: number; asyncGet?: boolean }) => {
  const store = new Map<string, string>(Object.entries(opts.seed ?? {}))
  const start = Date.now()
  const readyAfter = opts.readyAfterMs ?? 0
  const read = (k: string) => (Date.now() - start < readyAfter ? null : store.get(k) ?? null)
  ;(window as unknown as { GamePix?: unknown }).GamePix = {
    localStorage: {
      // `asyncGet` mirrors the real portal SDK, whose `getItem` returns a
      // Promise; the sync mode mirrors the localhost test SDK.
      getItem: (k: string) => (opts.asyncGet ? Promise.resolve(read(k)) : read(k)),
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) }
    }
  }
  return store
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  delete (window as unknown as { GamePix?: unknown }).GamePix
})

describe('GamePixStrategy.hydrate — async portal-data load (reload-reset bug)', () => {
  it('waits for late-arriving portal data instead of latching success-empty', async () => {
    const cloud = JSON.stringify({ spinner_coins: 777, spinner_campaign_stage: 4 })
    installFakePortal({ seed: { [STATE_KEY]: cloud }, readyAfterMs: 1200 })
    const local = makeLocal()
    const strat = new GamePixStrategy()

    const p = strat.hydrate(local)
    // Past the async-load delay but well under the 3s hydrate timeout.
    await vi.advanceTimersByTimeAsync(1400)
    await p

    expect(strat.hydrateState).toBe('success-with-data')
    expect(local.get(STATE_KEY)).toBe(cloud) // the player's save was restored
  })

  it('handles an ASYNC (Promise-returning) getItem — the portal SDK shape', async () => {
    // The real GamePix portal `getItem` resolves a Promise (vs the localhost
    // test SDK's sync string). The old code did `typeof value === 'string'` on
    // the Promise → false → mirrored nothing → reset. Now we await it.
    const cloud = JSON.stringify({ spinner_coins: 321, spinner_campaign_stage: 6 })
    installFakePortal({ seed: { [STATE_KEY]: cloud }, readyAfterMs: 0, asyncGet: true })
    const local = makeLocal()
    const strat = new GamePixStrategy()

    const p = strat.hydrate(local)
    await vi.advanceTimersByTimeAsync(100)
    await p

    expect(strat.hydrateState).toBe('success-with-data')
    expect(local.get(STATE_KEY)).toBe(cloud)
  })

  it('handles async getItem that also loads late', async () => {
    const cloud = JSON.stringify({ spinner_coins: 42 })
    installFakePortal({ seed: { [STATE_KEY]: cloud }, readyAfterMs: 1000, asyncGet: true })
    const local = makeLocal()
    const strat = new GamePixStrategy()

    const p = strat.hydrate(local)
    await vi.advanceTimersByTimeAsync(1200)
    await p

    expect(strat.hydrateState).toBe('success-with-data')
    expect(local.get(STATE_KEY)).toBe(cloud)
  })

  it('restores immediately when portal data is already present (returning player, fast path)', async () => {
    const cloud = JSON.stringify({ spinner_coins: 50 })
    installFakePortal({ seed: { [STATE_KEY]: cloud }, readyAfterMs: 0 })
    const local = makeLocal()
    const strat = new GamePixStrategy()

    const p = strat.hydrate(local)
    await vi.advanceTimersByTimeAsync(100)
    await p

    expect(strat.hydrateState).toBe('success-with-data')
    expect(local.get(STATE_KEY)).toBe(cloud)
  })

  it('concludes success-empty for a genuinely new player after the timeout (no data ever)', async () => {
    installFakePortal({ seed: {}, readyAfterMs: 0 }) // store reachable, but empty
    const local = makeLocal()
    const strat = new GamePixStrategy()

    const p = strat.hydrate(local)
    await vi.advanceTimersByTimeAsync(3100) // past HYDRATE_DATA_TIMEOUT_MS
    await p

    expect(strat.hydrateState).toBe('success-empty')
    expect(local.get(STATE_KEY)).toBeNull()
  })

  it('does not block boot waiting for the portal when the local blob already has state', async () => {
    // localhost / native-persistent platforms: the blob seed already holds the
    // save, so hydrate must NOT stall for the full 3s — a quick portal peek
    // only. We assert the hydrate promise settles well before the 3s timeout.
    installFakePortal({ seed: {}, readyAfterMs: 0 }) // portal reachable, empty
    const local = makeLocal()
    local.set(STATE_KEY, JSON.stringify({ spinner_coins: 10 })) // raw-seed fallback

    const strat = new GamePixStrategy()
    let settled = false
    const p = strat.hydrate(local).then(() => { settled = true })

    await vi.advanceTimersByTimeAsync(700) // just past PORTAL_QUICK_MS (600)
    await p
    expect(settled).toBe(true)
    // The local seed is untouched — the game still has its save.
    expect(local.get(STATE_KEY)).toBe(JSON.stringify({ spinner_coins: 10 }))
  })

  it('does NOT overwrite the local seed when the portal is slow — data wins once it loads', async () => {
    // Portal has the real save but it loads at 1s. Proves the poll keeps
    // waiting past the point where the old code (single read at ~0ms) gave up.
    const cloud = JSON.stringify({ spinner_coins: 999 })
    installFakePortal({ seed: { [STATE_KEY]: cloud }, readyAfterMs: 1000 })
    const local = makeLocal()
    const strat = new GamePixStrategy()

    const p = strat.hydrate(local)
    await vi.advanceTimersByTimeAsync(400)
    // Still nothing at 400ms — the old code would already have latched empty.
    expect(local.get(STATE_KEY)).toBeNull()
    await vi.advanceTimersByTimeAsync(900) // cross the 1s ready mark
    await p

    expect(strat.hydrateState).toBe('success-with-data')
    expect(local.get(STATE_KEY)).toBe(cloud)
  })
})
