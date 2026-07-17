// Unit tests for the rewarded-ad rolling-window throttle. Verifies the
// 5-in-10-min cap, expiry, persistence, and graceful handling of a
// corrupted localStorage blob. Module is reloaded per test (`vi.resetModules`)
// so the in-memory `history` ref doesn't leak across cases.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = '__save_internal__rewarded_history'

const importThrottle = async () => {
  vi.resetModules()
  return await import('@/use/useRewardedThrottle')
}

describe('useRewardedThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.localStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts un-throttled when no history exists', async () => {
    const mod = await importThrottle()
    expect(mod.isRewardedThrottled.value).toBe(false)
  })

  it('throttles after MAX_REWARDED grants in the window', async () => {
    const mod = await importThrottle()
    for (let i = 0; i < mod.MAX_REWARDED; i++) {
      mod.recordRewardedGranted()
    }
    expect(mod.isRewardedThrottled.value).toBe(true)
  })

  it('does NOT throttle below the cap', async () => {
    const mod = await importThrottle()
    for (let i = 0; i < mod.MAX_REWARDED - 1; i++) {
      mod.recordRewardedGranted()
    }
    expect(mod.isRewardedThrottled.value).toBe(false)
  })

  it('un-throttles once the oldest entry rolls past the window', async () => {
    const mod = await importThrottle()
    const start = Date.now()
    for (let i = 0; i < mod.MAX_REWARDED; i++) {
      mod.recordRewardedGranted(start + i)
    }
    expect(mod.isRewardedThrottled.value).toBe(true)

    // Jump past the window — all five entries are now stale. The prune
    // hook invalidates the computed (which caches because `Date.now()`
    // isn't a reactive dep — see implementation comment).
    vi.setSystemTime(start + mod.AD_WINDOW_MS + 1)
    mod.__pruneRewardedThrottleForTest()
    expect(mod.isRewardedThrottled.value).toBe(false)
  })

  it('sliding window: a single grant still counts after 4 fall off', async () => {
    const mod = await importThrottle()
    const start = Date.now()
    // Five grants spread across the window so the oldest 4 expire
    // first while the newest stays.
    mod.recordRewardedGranted(start)
    mod.recordRewardedGranted(start + 1000)
    mod.recordRewardedGranted(start + 2000)
    mod.recordRewardedGranted(start + 3000)
    mod.recordRewardedGranted(start + mod.AD_WINDOW_MS - 1000) // newest, late in window
    expect(mod.isRewardedThrottled.value).toBe(true)

    // Move just past when the first 4 expire — only the late one remains.
    vi.setSystemTime(start + mod.AD_WINDOW_MS + 100)
    mod.__pruneRewardedThrottleForTest()
    expect(mod.isRewardedThrottled.value).toBe(false)
  })

  it('persists history inside the midnight_state blob under the internal-key field', async () => {
    const mod = await importThrottle()
    mod.recordRewardedGranted(123_456)
    // The blob write is debounced (it rides the single-blob persist debounce),
    // so advance past it before asserting the on-disk contents.
    vi.advanceTimersByTime(300)
    // Single-blob storage: nothing lives at the bare key any more — the
    // history is a sub-field of `midnight_state`.
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    const blob = JSON.parse(window.localStorage.getItem('midnight_state') || '{}')
    expect(blob[STORAGE_KEY]).toEqual([123_456])
  })

  it('restores history from localStorage on module load', async () => {
    const seed = [Date.now() - 1000, Date.now() - 500, Date.now() - 100]
    // Single-blob model: the throttle reads its history as a field of the
    // consolidated blob, so seed it there (not at the bare key).
    window.localStorage.setItem('midnight_state', JSON.stringify({ [STORAGE_KEY]: seed }))
    const mod = await importThrottle()
    // 3 entries < MAX (5), so still un-throttled, but the next 2 must throttle.
    expect(mod.isRewardedThrottled.value).toBe(false)
    mod.recordRewardedGranted()
    mod.recordRewardedGranted()
    expect(mod.isRewardedThrottled.value).toBe(true)
  })

  it('survives malformed JSON in localStorage', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'not-json{')
    const mod = await importThrottle()
    expect(mod.isRewardedThrottled.value).toBe(false)
  })

  it('survives a non-array JSON value in localStorage', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ foo: 'bar' }))
    const mod = await importThrottle()
    expect(mod.isRewardedThrottled.value).toBe(false)
  })

  it('filters non-numeric entries when restoring', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([Date.now(), 'oops', null, Date.now()])
    )
    const mod = await importThrottle()
    // Two valid entries restored; below the cap.
    expect(mod.isRewardedThrottled.value).toBe(false)
  })

  it('resetRewardedThrottle clears in-memory state and storage', async () => {
    const mod = await importThrottle()
    for (let i = 0; i < mod.MAX_REWARDED; i++) mod.recordRewardedGranted()
    expect(mod.isRewardedThrottled.value).toBe(true)
    mod.resetRewardedThrottle()
    expect(mod.isRewardedThrottled.value).toBe(false)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
  })
})
