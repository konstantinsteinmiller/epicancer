import { ref, type Ref } from 'vue'

/**
 * Single-blob localStorage layer for Midnight Analog.
 *
 * EVERY persisted gameplay value the game touches lives inside ONE in-memory
 * record — `midnightState` — and only ONE localStorage key is ever written:
 * `midnight_state`. The cloud-sync subsystem (SaveManager / strategies) only
 * has to mirror this single key (plus the `__save_meta__` blob) for a complete
 * save. This keeps localStorage pollution minimal and makes cloud hydration a
 * single-object round-trip.
 *
 * Field names inside the record use the `ma_` prefix for game progress
 * (`ma_best_score`, `ma_nights_survived`, …). The cross-cutting settings
 * subsystems reused from the platform layer keep their original `spinner_`
 * field names (sound/music volume, language) — these are just keys INSIDE the
 * one blob, not their own localStorage entries, so there is no extra pollution.
 *
 * Writes are debounced (trailing edge, hard-capped) and hard-flushed on
 * `pagehide` / tab-hide so a close mid-burst never drops data.
 */

export const STATE_KEY = 'midnight_state'

/** Persisted values may be bare strings ("en"), stringified numbers ("120"),
 *  or stringified JSON. JSON.parse round-trips numbers/objects; bare strings
 *  throw, so we fall back to the raw value. Used by the one-shot fold of any
 *  legacy individual key into the blob. */
const tryParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

const persistRaw = (blob: Record<string, unknown>): void => {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(blob)) } catch { /* quota / private mode */ }
}

// ─── Debounced write batching ─────────────────────────────────────────
// The in-memory ref update is synchronous (consumers expect the new value to
// be readable immediately), but the actual localStorage persist is coalesced
// into a single trailing-edge write after PERSIST_DEBOUNCE_MS of quiet, with a
// hard cap so a continuous stream (score ticking every frame) still flushes
// roughly every PERSIST_MAX_WAIT_MS.
const PERSIST_DEBOUNCE_MS = 200
const PERSIST_MAX_WAIT_MS = 2500
let persistTimer: ReturnType<typeof setTimeout> | null = null
let firstDirtyAt = 0

/** Force the debounced blob write to happen NOW — cancels the pending timer
 *  and writes `midnight_state` to localStorage synchronously. Called from
 *  the page-hide handlers below and (via `useSaveStatus.flushSaveNow`) at hard
 *  checkpoints (night survived, new best score) so the cloud push starts
 *  immediately instead of waiting out the debounce. */
export const flushPersist = (): void => {
  if (persistTimer != null) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  firstDirtyAt = 0
  persistRaw(midnightState.value)
}

const schedulePersist = (): void => {
  const now = Date.now()
  if (firstDirtyAt === 0) firstDirtyAt = now
  if (persistTimer != null) clearTimeout(persistTimer)
  const remaining = PERSIST_MAX_WAIT_MS - (now - firstDirtyAt)
  const delay = Math.max(0, Math.min(PERSIST_DEBOUNCE_MS, remaining))
  persistTimer = setTimeout(() => {
    persistTimer = null
    firstDirtyAt = 0
    persistRaw(midnightState.value)
  }, delay)
}

if (typeof window !== 'undefined') {
  const onHide = () => flushPersist()
  window.addEventListener('pagehide', onHide)
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersist()
  })
}

const buildInitial = (): Record<string, unknown> => {
  let blob: Record<string, unknown> = {}

  // Load the consolidated blob if a previous run already wrote it.
  try {
    const raw = localStorage.getItem(STATE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        blob = parsed as Record<string, unknown>
      }
    }
  } catch { /* corrupt → start fresh */ }

  // Generic fold: if a returning player somehow has individual `spinner_*`
  // settings entries in raw localStorage (e.g. carried over from an earlier
  // shared-platform build), fold them into the blob once and remove them. The
  // blob takes precedence if both exist.
  let migrated = false
  try {
    const stragglers: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('spinner_user_')) stragglers.push(k)
    }
    for (const k of stragglers) {
      const raw = localStorage.getItem(k)
      if (raw === null) continue
      if (!(k in blob)) blob[k] = tryParse(raw)
      try { localStorage.removeItem(k) } catch { /* harmless */ }
      migrated = true
    }
  } catch { /* harmless */ }

  if (migrated) persistRaw(blob)
  return blob
}

/** The single in-memory aggregate of all persisted game state. */
export const midnightState: Ref<Record<string, unknown>> = ref(buildInitial())

/** Read a value out of the blob. `fallback` is returned when the key is
 *  absent. Type parameter is advisory — the layer does not validate shape. */
export const getState = <T = unknown>(key: string, fallback?: T): T => {
  const v = midnightState.value[key]
  return (v === undefined ? fallback : v) as T
}

export const hasState = (key: string): boolean => midnightState.value[key] !== undefined

export const setState = (key: string, value: unknown): void => {
  midnightState.value = { ...midnightState.value, [key]: value }
  schedulePersist()
}

export const removeState = (key: string): void => {
  if (midnightState.value[key] === undefined) return
  const next = { ...midnightState.value }
  delete next[key]
  midnightState.value = next
  schedulePersist()
}

/** Re-read from localStorage. Used by the SaveManager hydrate watcher
 *  (`saveDataVersion`) so cloud-sourced updates show up in-memory. */
export const reloadMidnightState = (): void => {
  midnightState.value = buildInitial()
}

/** Test-only: wipe both the in-memory blob and the persisted entry. */
export const __resetMidnightState = (): void => {
  midnightState.value = {}
  try { localStorage.removeItem(STATE_KEY) } catch { /* harmless */ }
}
