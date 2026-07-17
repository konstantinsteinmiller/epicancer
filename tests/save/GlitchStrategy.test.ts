import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GlitchStrategy, type ConflictResolver } from '@/utils/save/GlitchStrategy'
import { SaveManager } from '@/utils/save/SaveManager'
import { SAVE_KEYS } from '@/utils/save/SaveMergePolicy'

// ─── test helpers ──────────────────────────────────────────────────────────

const TITLE_ID = 'ebaca9c7-aeff-41c4-9169-a26bdf49cd34'
const INSTALL_ID = 'install-xyz'
const TOKEN = 'test-token'
const BASE_URL = 'https://api.test.local/api'

const savesUrl = `${BASE_URL}/titles/${TITLE_ID}/installs/${INSTALL_ID}/saves`
const resolveUrl = (saveId: string) =>
  `${BASE_URL}/titles/${TITLE_ID}/installs/${INSTALL_ID}/saves/${saveId}/resolve`

type Handler = (init: RequestInit | undefined, url: string) => Response | Promise<Response>

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

const base64Encode = (s: string): string => {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

const makeFetch = (handlers: Record<string, Handler>) => {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    // Match on URL + method since list and upload share a path.
    const method = (init?.method ?? 'GET').toUpperCase()
    const key = `${method} ${url}`
    const handler = handlers[key]
    if (!handler) {
      throw new Error(`Unexpected request: ${key}`)
    }
    return handler(init, url)
  })
}

const makeStrategy = (overrides: Partial<ConstructorParameters<typeof GlitchStrategy>[0]> = {}) => {
  const fetchImpl = overrides.fetchImpl as ReturnType<typeof makeFetch>
  return new GlitchStrategy({
    titleId: TITLE_ID,
    installId: INSTALL_ID,
    token: TOKEN,
    baseUrl: BASE_URL,
    fetchImpl,
    ...overrides
  })
}

describe('GlitchStrategy (isGlitch guard)', () => {
  beforeEach(() => {
    // setup.ts's beforeEach already installed a fresh in-memory
    // localStorage — no need to clear. We only need fake timers here
    // so `setTimeout`-based flushes can be inspected deterministically.
    vi.useFakeTimers()
  })
  afterEach(() => {
    // Explicitly drop any still-pending fake timer callbacks before
    // handing control back to real timers. Otherwise scheduled flushes
    // from the just-run test can fire after the test's fetch mock has
    // gone out of scope, producing an unhandled rejection.
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('hydrates local state from the Glitch save list', async () => {
    const payload = { spinner_coins: '99', spinner_player_team: '[1,2]' }
    const fetchImpl = makeFetch({
      [`GET ${savesUrl}`]: () =>
        jsonResponse({
          data: [
            {
              id: 'save-uuid-1',
              slot_index: 0,
              version: 5,
              payload: base64Encode(JSON.stringify(payload)),
              checksum: 'deadbeef',
              is_conflicted: false
            }
          ]
        })
    })
    const strategy = makeStrategy({ fetchImpl })
    const manager = new SaveManager(strategy)
    await manager.init()

    expect(window.localStorage.getItem('spinner_coins')).toBe('99')
    expect(window.localStorage.getItem('spinner_player_team')).toBe('[1,2]')
    expect(strategy.getBaseVersion()).toBe(5)
    expect(strategy.getSaveId()).toBe('save-uuid-1')
  })

  it('starts at base_version=0 when no prior slot exists', async () => {
    const fetchImpl = makeFetch({
      [`GET ${savesUrl}`]: () => jsonResponse({ data: [] })
    })
    const strategy = makeStrategy({ fetchImpl })
    const manager = new SaveManager(strategy)
    await manager.init()

    expect(strategy.getBaseVersion()).toBe(0)
    expect(strategy.getSaveId()).toBeNull()
  })

  it('uploads a bundled Base64 payload with a SHA-256 checksum on write', async () => {
    const uploads: { body: any }[] = []
    const fetchImpl = makeFetch({
      [`GET ${savesUrl}`]: () => jsonResponse({ data: [] }),
      [`POST ${savesUrl}`]: (init) => {
        const body = JSON.parse(String(init?.body))
        uploads.push({ body })
        return jsonResponse({ data: { version: 1, is_conflicted: false } }, 201)
      }
    })
    const strategy = makeStrategy({ fetchImpl })
    const manager = new SaveManager(strategy)
    await manager.init()

    window.localStorage.setItem('spinner_coins', '10')

    await vi.runAllTimersAsync()
    // Await the inflight upload triggered by the scheduled flush.
    await manager.flush()

    expect(uploads).toHaveLength(1)
    const body = uploads[0]!.body
    expect(body.slot_index).toBe(0)
    expect(body.base_version).toBe(0)
    expect(body.save_type).toBe('auto')
    expect(typeof body.client_timestamp).toBe('string')

    // Decode payload and verify content round-trips.
    const decoded = JSON.parse(atob(body.payload))
    expect(decoded.spinner_coins).toBe('10')

    // Checksum must match SHA-256 of the raw JSON bytes.
    const bytes = new TextEncoder().encode(JSON.stringify(decoded))
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hex = Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    expect(body.checksum).toBe(hex)

    expect(strategy.getBaseVersion()).toBe(1)
  })

  it('handles 409 conflicts by calling /resolve with the default use_client policy', async () => {
    let postCalls = 0
    const fetchImpl = makeFetch({
      [`GET ${savesUrl}`]: () =>
        jsonResponse({
          data: [
            {
              id: 'save-uuid-2',
              slot_index: 0,
              version: 1,
              payload: base64Encode('{}')
            }
          ]
        }),
      [`POST ${savesUrl}`]: () => {
        postCalls++
        return jsonResponse(
          {
            status: 'conflict',
            conflict_id: 'conflict-uuid-1',
            server_version: 4,
            message: 'A newer version exists...'
          },
          409
        )
      },
      [`POST ${resolveUrl('save-uuid-2')}`]: (init) => {
        const body = JSON.parse(String(init?.body))
        expect(body.conflict_id).toBe('conflict-uuid-1')
        expect(body.choice).toBe('use_client')
        return jsonResponse({
          data: { id: 'save-uuid-2', version: 5, is_conflicted: false }
        })
      }
    })
    const strategy = makeStrategy({ fetchImpl })
    const manager = new SaveManager(strategy)
    await manager.init()

    window.localStorage.setItem('spinner_coins', '77')
    await manager.flush()

    expect(postCalls).toBe(1)
    expect(strategy.getBaseVersion()).toBe(5)
  })

  it('respects a custom keep_server conflict resolver and refreshes from the server', async () => {
    const remotePayload = { spinner_coins: '200' }
    const fetchImpl = makeFetch({
      [`GET ${savesUrl}`]: () =>
        jsonResponse({
          data: [
            {
              id: 'save-uuid-3',
              slot_index: 0,
              version: 1,
              payload: base64Encode(JSON.stringify({ spinner_coins: '1' }))
            }
          ]
        }),
      [`POST ${savesUrl}`]: () =>
        jsonResponse(
          {
            status: 'conflict',
            conflict_id: 'conflict-uuid-2',
            server_version: 7,
            message: 'stale'
          },
          409
        ),
      [`POST ${resolveUrl('save-uuid-3')}`]: () => {
        // Return a version + then the follow-up GET serves the new payload.
        return jsonResponse({
          data: { id: 'save-uuid-3', version: 8, is_conflicted: false }
        })
      }
    })
    // Swap GET handler to return updated payload after the resolve.
    // Vitest's mock lets us override per-call.
    let getCalls = 0
    const dynamicFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'GET' && url === savesUrl) {
        getCalls++
        if (getCalls === 1) {
          return jsonResponse({
            data: [
              {
                id: 'save-uuid-3',
                slot_index: 0,
                version: 1,
                payload: base64Encode(JSON.stringify({ spinner_coins: '1' }))
              }
            ]
          })
        }
        return jsonResponse({
          data: [
            {
              id: 'save-uuid-3',
              slot_index: 0,
              version: 8,
              payload: base64Encode(JSON.stringify(remotePayload))
            }
          ]
        })
      }
      if (method === 'POST' && url === savesUrl) {
        return jsonResponse(
          {
            status: 'conflict',
            conflict_id: 'conflict-uuid-2',
            server_version: 7,
            message: 'stale'
          },
          409
        )
      }
      if (method === 'POST' && url === resolveUrl('save-uuid-3')) {
        return jsonResponse({
          data: { id: 'save-uuid-3', version: 8, is_conflicted: false }
        })
      }
      throw new Error(`unhandled ${method} ${url}`)
    })

    const onConflict: ConflictResolver = () => 'keep_server'
    const strategy = makeStrategy({ fetchImpl: dynamicFetch, onConflict })
    const manager = new SaveManager(strategy)
    await manager.init()

    expect(window.localStorage.getItem('spinner_coins')).toBe('1')

    window.localStorage.setItem('spinner_coins', '999')
    await manager.flush()

    expect(window.localStorage.getItem('spinner_coins')).toBe('200')
    expect(strategy.getBaseVersion()).toBe(8)
  })

  it('degrades to a pure local mirror when list fetch fails', async () => {
    // Pre-seed local with non-fresh data so SaveManager's boot-time
    // sanity guard doesn't engage (it only retries when local looks like
    // fresh defaults — see SaveManager.shouldRunSanityGuard). The point
    // of THIS test is the local-mirror fallback, not the retry behaviour.
    // The guard judges freshness on the real progression keys, so it has to
    // be one of those — a settings key wouldn't count as progress and the
    // guard would burn its 3×1s retry ladder and time this test out.
    window.localStorage.setItem(SAVE_KEYS.BEST_SCORE, '5')
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }))
    const strategy = makeStrategy({ fetchImpl })
    const manager = new SaveManager(strategy)

    await expect(manager.init()).resolves.toBeUndefined()

    // Local writes still succeed even without a working backend.
    window.localStorage.setItem('spinner_coins', '3')
    expect(window.localStorage.getItem('spinner_coins')).toBe('3')

    // Strategy schedules a background retry on failure — clean it up so
    // the test runner doesn't hang on the pending timer.
    strategy.dispose()
  })

  it('sorts payload keys alphabetically so the SHA-256 checksum is deterministic', async () => {
    // Simulate two sessions that wrote the same data in different orders:
    // without sorting, the raw JSON bytes would differ and the checksums
    // would diverge — which Glitch would flag as a phantom conflict.
    // Each run gets a fresh in-memory localStorage so the two SaveManager
    // instances don't stack patches on the same storage object.
    const captureChecksum = async (writeOrder: Array<[string, string]>) => {
      const memory = new Map<string, string>()
      const storage: Storage = {
        get length() {
          return memory.size
        },
        clear: () => memory.clear(),
        getItem: (k) => (memory.has(k) ? memory.get(k)! : null),
        key: (i) => Array.from(memory.keys())[i] ?? null,
        removeItem: (k) => {
          memory.delete(k)
        },
        setItem: (k, v) => {
          memory.set(k, String(v))
        }
      }
      let captured: any = null
      const fetchImpl = makeFetch({
        [`GET ${savesUrl}`]: () => jsonResponse({ data: [] }),
        [`POST ${savesUrl}`]: (init) => {
          captured = JSON.parse(String(init?.body))
          return jsonResponse({ data: { version: 1, is_conflicted: false } }, 201)
        }
      })
      const strategy = makeStrategy({ fetchImpl })
      const manager = new SaveManager(strategy, storage)
      await manager.init()
      for (const [k, v] of writeOrder) storage.setItem(k, v)
      await manager.flush()
      return {
        checksum: captured.checksum as string,
        payload: captured.payload as string
      }
    }

    const a = await captureChecksum([
      ['spinner_coins', '10'],
      ['spinner_player_team', '[1]'],
      ['spinner_user_language', 'en']
    ])
    const b = await captureChecksum([
      ['spinner_user_language', 'en'],
      ['spinner_player_team', '[1]'],
      ['spinner_coins', '10']
    ])

    expect(a.checksum).toBe(b.checksum)
    expect(a.payload).toBe(b.payload)

    // And the sorted order is actually alphabetical (not just stable).
    // `__save_meta__` sorts first because `_` < `s` lexicographically.
    // The strategy now writes a meta blob alongside player data so future
    // hydrates can compare progress (see SaveMergePolicy.ts).
    const decoded = JSON.parse(atob(a.payload))
    expect(Object.keys(decoded)).toEqual([
      '__save_meta__',
      'spinner_coins',
      'spinner_player_team',
      'spinner_user_language'
    ])
  })

  it('excludes internal bookkeeping keys from the payload', async () => {
    let captured: any = null
    const fetchImpl = makeFetch({
      [`GET ${savesUrl}`]: () => jsonResponse({ data: [] }),
      [`POST ${savesUrl}`]: (init) => {
        captured = JSON.parse(String(init?.body))
        return jsonResponse({ data: { version: 1, is_conflicted: false } }, 201)
      }
    })
    const strategy = makeStrategy({ fetchImpl })
    const manager = new SaveManager(strategy)
    await manager.init()

    window.localStorage.setItem('spinner_coins', '1')
    await manager.flush()

    // `__save_meta__` is written by every flush so the next hydrate can
    // compare progress for merge decisions — it's part of the payload by
    // design now, alongside the player's own keys. The internal
    // bookkeeping keys (`__save_internal__*`) are still excluded.
    const decoded = JSON.parse(atob(captured.payload))
    expect(Object.keys(decoded)).toEqual(['__save_meta__', 'spinner_coins'])
  })

  it('flips to guest-blocked mode on 403 and suppresses further uploads', async () => {
    // First GET returns 403 — strategy should disable itself during hydrate,
    // then any POST that would have followed must not fire.
    const onGuestBlocked = vi.fn()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'GET' && url === savesUrl) {
        return jsonResponse(
          { status: 'error', message: 'Guest accounts cannot save to the cloud' },
          403
        )
      }
      throw new Error(`unexpected ${method} ${url}`)
    })
    const strategy = makeStrategy({ fetchImpl, onGuestBlocked })
    const manager = new SaveManager(strategy)
    await manager.init()

    expect(strategy.isGuestBlocked()).toBe(true)
    expect(onGuestBlocked).toHaveBeenCalledTimes(1)
    expect(onGuestBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'list' })
    )

    // Subsequent writes must not trigger any POST — only the one GET.
    window.localStorage.setItem('spinner_coins', '5')
    await manager.flush()

    const postCalls = fetchImpl.mock.calls.filter(
      ([_, init]) => (init as RequestInit | undefined)?.method === 'POST'
    )
    expect(postCalls).toHaveLength(0)

    // Local write still landed — backend is off but localStorage mirror works.
    expect(window.localStorage.getItem('spinner_coins')).toBe('5')
  })

  it('flips to guest-blocked on 403 during upload, cancelling pending flushes', async () => {
    const onGuestBlocked = vi.fn()
    let postCount = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'GET' && url === savesUrl) {
        return jsonResponse({ data: [] })
      }
      if (method === 'POST' && url === savesUrl) {
        postCount++
        return jsonResponse(
          { status: 'error', message: 'Guest accounts cannot save to the cloud' },
          403
        )
      }
      throw new Error(`unexpected ${method} ${url}`)
    })
    const strategy = makeStrategy({ fetchImpl, onGuestBlocked })
    const manager = new SaveManager(strategy)
    await manager.init()

    window.localStorage.setItem('spinner_coins', '5')
    await manager.flush()

    expect(postCount).toBe(1)
    expect(strategy.isGuestBlocked()).toBe(true)
    expect(onGuestBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'upload' })
    )

    // More writes → no more POSTs.
    window.localStorage.setItem('spinner_coins', '6')
    await manager.flush()
    expect(postCount).toBe(1)
  })

  it('skips upload when the encoded payload would exceed 10MB', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
    })
    let postCount = 0
    const fetchImpl = makeFetch({
      [`GET ${savesUrl}`]: () => jsonResponse({ data: [] }),
      [`POST ${savesUrl}`]: () => {
        postCount++
        return jsonResponse({ data: { version: 1, is_conflicted: false } }, 201)
      }
    })
    const strategy = makeStrategy({ fetchImpl })
    const manager = new SaveManager(strategy)
    await manager.init()

    // 10MB+ payload — `a`.repeat(10M) Base64-encodes to ~13.3MB, safely
    // over the limit.
    const bigValue = 'a'.repeat(10 * 1024 * 1024)
    window.localStorage.setItem('spinner_huge_test', bigValue)
    await manager.flush()

    expect(postCount).toBe(0)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('exceeds 10MB limit')
    )
    errorSpy.mockRestore()
  })

  it('does not round-trip its own version/save-id keys through the payload', async () => {
    let captured: any = null
    const fetchImpl = makeFetch({
      [`GET ${savesUrl}`]: () =>
        jsonResponse({
          data: [
            {
              id: 'save-uuid-9',
              slot_index: 0,
              version: 2,
              payload: base64Encode('{}')
            }
          ]
        }),
      [`POST ${savesUrl}`]: (init) => {
        captured = JSON.parse(String(init?.body))
        return jsonResponse({ data: { version: 3, is_conflicted: false } }, 201)
      }
    })
    const strategy = makeStrategy({ fetchImpl })
    const manager = new SaveManager(strategy)
    await manager.init()

    window.localStorage.setItem('spinner_coins', '1')
    await manager.flush()

    const decoded = JSON.parse(atob(captured.payload))
    expect(decoded).not.toHaveProperty('__save_internal__glitch_version')
    expect(decoded).not.toHaveProperty('__save_internal__glitch_save_id')
    expect(decoded.spinner_coins).toBe('1')
  })
})
